// Checkout orchestrator (SPEC §6). Owns the UI state machine, the persisted attempt snapshot and every
// payment request. Invariants it upholds:
// - the snapshot is saved before any request and before opening a sheet or browser;
// - uncertainty (timeout, network, 5xx, lost response) leads to reconciliation, never a new key;
// - deep links, sheet results and foregrounding are only signals; the server decides the outcome.

import type { Attempt, CreateAttemptRequest, OrderQuote, PaymentMethod } from '@shared';
import { ApiError, isHttpError, isUncertain, type PaymentApi } from '../api/paymentApi';
import { createCheckoutReducer, initialCheckoutState } from '../domain/checkout.reducer';
import {
  canChangeQuantity,
  isWalletMethod,
  type CheckoutAction,
  type CheckoutState,
  type ReconcileReason,
  type RetryReason,
} from '../domain/checkout.types';
import type { LogEvent, Logger } from '../logger';
import type { PaymentAdapter } from '../payments/types';
import type { AttemptSnapshot, AttemptStore } from './attemptStore';

export type OrderLoad = { status: 'loading' } | { status: 'loaded'; quote: OrderQuote } | { status: 'error' };

export type CheckoutView = {
  state: CheckoutState;
  order: OrderLoad;
  /** Read-only copy for the dev menu. It never holds sensitive fields because none are stored. */
  snapshot: AttemptSnapshot | null;
};

export type OrchestratorDeps = {
  api: PaymentApi;
  store: AttemptStore;
  adapters: Record<PaymentMethod, PaymentAdapter>;
  logger: Logger;
  orderId: string;
  newId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Eligibility with the current capabilities (and dev overrides) for a quote. */
  isEligible: (method: PaymentMethod, quote: OrderQuote) => boolean;
  /** Reconciliation backoff between GETs (SPEC §6.4). */
  backoffMs?: readonly number[];
  /** Pause between same-key create retries (SPEC §6.2 step 3). */
  createRetryDelayMs?: number;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000] as const;
const CREATE_ATTEMPTS = 3; // first try + 2 retries with the same key

type Mapped = 'final' | 'pending' | 'awaiting_user';
type StepResult = 'done' | 'uncertain';

const RETURN_URL_RE = /^gametime-demo:\/\/payment\/return(?:\?(.*))?$/;

/** Parses `gametime-demo://payment/return?attemptId=…&result=…` without relying on URL support. */
export function parseReturnUrl(url: string): { attemptId: string | null; result: string | null } | null {
  const match = RETURN_URL_RE.exec(url);
  if (!match) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const pair of (match[1] ?? '').split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k) {
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  return { attemptId: params.attemptId ?? null, result: params.result ?? null };
}

function retryReason(err: unknown): RetryReason {
  if (err instanceof ApiError) {
    return err.kind === 'timeout' ? 'timeout' : err.kind === 'network' ? 'network' : 'server';
  }
  return 'network';
}

export class CheckoutOrchestrator {
  private state: CheckoutState = initialCheckoutState;
  private order: OrderLoad = { status: 'loading' };
  private snapshot: AttemptSnapshot | null = null;
  /** In memory only (invariant 4). Lets reconciliation retry the authorize with the same key. */
  private pendingToken: string | null = null;
  /** A create/authorize request or a wallet sheet is in flight in this process. */
  private localOp = false;
  private booted = false;
  private initPromise: Promise<void> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private view: CheckoutView;
  private readonly listeners = new Set<() => void>();
  private readonly reducer;
  private readonly backoffMs: readonly number[];
  private readonly createRetryDelayMs: number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.reducer = createCheckoutReducer((state, action) =>
      this.log('invalid_transition', { status: state.tag, code: action.type }),
    );
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.createRetryDelayMs = deps.createRetryDelayMs ?? 1000;
    this.view = this.buildView();
  }

  // ---------- Store interface (useSyncExternalStore) ----------

  getView = (): CheckoutView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private buildView(): CheckoutView {
    return { state: this.state, order: this.order, snapshot: this.snapshot ? { ...this.snapshot } : null };
  }

  private emit(): void {
    this.view = this.buildView();
    this.listeners.forEach(l => l());
  }

  private dispatch(action: CheckoutAction): void {
    const next = this.reducer(this.state, action);
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  private log(event: LogEvent, attrs: Record<string, unknown> = {}): void {
    const s = this.snapshot;
    this.deps.logger.log(event, {
      ...(s ? { attemptId: s.attemptId ?? undefined, clientAttemptId: s.clientAttemptId, method: s.method, phase: s.phase, orderVersion: s.orderVersion } : {}),
      ...attrs,
    });
  }

  // ---------- Snapshot ----------

  /** Saves the snapshot. Returns false if storage failed. */
  private async persist(snapshot: AttemptSnapshot): Promise<boolean> {
    this.snapshot = snapshot;
    this.emit();
    try {
      await this.deps.store.save(snapshot);
      return true;
    } catch {
      this.log('storage_error', { code: 'save' });
      return false;
    }
  }

  private async clearSnapshot(): Promise<void> {
    this.snapshot = null;
    this.pendingToken = null;
    this.emit();
    try {
      await this.deps.store.clear();
    } catch {
      this.log('storage_error', { code: 'clear' });
    }
  }

  // ---------- Boot and order ----------

  /** Cold start: load the snapshot, load the order, and reconcile before enabling actions (SPEC §6.3). */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.boot();
    }
    return this.initPromise;
  }

  private async boot(): Promise<void> {
    this.log('checkout_viewed');
    try {
      this.snapshot = await this.deps.store.load();
    } catch {
      this.log('storage_error', { code: 'load' });
      this.snapshot = null;
    }
    await this.loadOrder();
    this.booted = true;
    this.emit();

    if (this.order.status === 'loaded' && this.order.quote.status === 'paid') {
      await this.showPaidOrder(this.order.quote);
      return;
    }
    if (this.snapshot) {
      await this.reconcile('cold_start');
    }
  }

  private async loadOrder(): Promise<OrderQuote | null> {
    try {
      const quote = await this.deps.api.getOrder(this.deps.orderId);
      this.applyQuote(quote);
      return quote;
    } catch {
      this.log('order_load_failed');
      if (this.order.status !== 'loaded') {
        this.order = { status: 'error' };
        this.emit();
      }
      return null;
    }
  }

  private applyQuote(quote: OrderQuote): void {
    const previous = this.order.status === 'loaded' ? this.order.quote : null;
    this.order = { status: 'loaded', quote };
    if (previous && previous.version !== quote.version) {
      this.log('quote_changed', { orderVersion: quote.version });
    }
    this.emit();
  }

  /** Reloads the order (retry after a load error, or after a dev menu total override). */
  async refreshOrder(): Promise<void> {
    await this.loadOrder();
  }

  private async showPaidOrder(quote: OrderQuote): Promise<void> {
    this.dispatch({ type: 'PAYMENT_SUCCEEDED', attemptId: quote.paidAttemptId ?? this.snapshot?.attemptId ?? 'unknown' });
    if (this.snapshot) {
      await this.clearSnapshot();
    }
  }

  // ---------- Start payment (SPEC §6.2) ----------

  /**
   * One tap starts the whole flow. The guard and the START_PAYMENT dispatch are synchronous, so a
   * second call in the same tick sees `creating` and is ignored (double tap).
   */
  async startPayment(method: PaymentMethod, options: { cardToken?: string } = {}): Promise<void> {
    if (!this.booted || this.state.tag !== 'ready' || this.snapshot || this.reconcilePromise || this.localOp) {
      return;
    }
    if (this.order.status !== 'loaded' || this.order.quote.status === 'paid') {
      return;
    }
    const quote = this.order.quote;
    if (!this.deps.isEligible(method, quote) || (method === 'card' && !options.cardToken)) {
      return;
    }
    this.dispatch({ type: 'START_PAYMENT', method });
    this.localOp = true;
    this.pendingToken = method === 'card' ? options.cardToken ?? null : null;

    try {
      const saved = await this.persist({
        v: 1,
        clientAttemptId: this.deps.newId(),
        authorizeKey: this.deps.newId(),
        attemptId: null,
        orderId: quote.orderId,
        orderVersion: quote.version,
        amountMinor: quote.total.minorUnits,
        method,
        phase: 'creating',
        startedAt: this.deps.now().toISOString(),
      });
      if (!saved) {
        // Without a persisted identity we must not send anything (invariant 3).
        await this.clearSnapshot();
        this.dispatch({ type: 'RESET_TO_READY' });
        return;
      }
      await this.runCreate();
    } finally {
      this.localOp = false;
    }
  }

  /** "Try again" from retryable_error: repeats the create with the SAME key. */
  async retry(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'retryable_error' || !snap || this.localOp) {
      return;
    }
    this.dispatch({ type: 'RETRY', method: snap.method });
    this.localOp = true;
    try {
      await this.runCreate();
    } finally {
      this.localOp = false;
    }
  }

  /** Gives up from retryable_error. Safe: an `awaiting_user` attempt is never authorized without a token. */
  async abandon(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'retryable_error' || !snap) {
      return;
    }
    if (snap.attemptId) {
      await this.cancelQuietly(snap.attemptId);
    }
    await this.clearSnapshot();
    this.dispatch({ type: 'RESET_TO_READY' });
  }

  private createBody(snap: AttemptSnapshot): CreateAttemptRequest {
    return {
      clientAttemptId: snap.clientAttemptId,
      order: { id: snap.orderId, version: snap.orderVersion },
      amount: { currency: 'USD', minorUnits: snap.amountMinor },
      method: snap.method,
    };
  }

  private async runCreate(): Promise<void> {
    const snap = this.snapshot!;
    let lastError: unknown = null;
    let attempt: Attempt | null = null;
    for (let i = 0; i < CREATE_ATTEMPTS && !attempt; i++) {
      if (i > 0) {
        await this.deps.sleep(this.createRetryDelayMs);
      }
      try {
        attempt = await this.deps.api.createAttempt(this.createBody(snap));
      } catch (err) {
        lastError = err;
        if (!isUncertain(err)) {
          break;
        }
      }
    }

    if (!attempt) {
      const next = await this.handleCreateError(lastError);
      if (next === 'reconcile') {
        await this.reconcile('processing');
      }
      return;
    }

    await this.persist({ ...snap, attemptId: attempt.attemptId, phase: 'awaiting_user' });
    this.log('payment_attempt_created', { status: attempt.status });
    if (attempt.status !== 'awaiting_user') {
      // Idempotent replay of an attempt that already moved on: show what the server says.
      if ((await this.mapAttempt(attempt)) !== 'final') {
        await this.reconcile('processing');
      }
      return;
    }
    await this.present(attempt);
  }

  /** Returns 'reconcile' when the caller should start reconciliation. */
  private async handleCreateError(err: unknown): Promise<'done' | 'reconcile'> {
    if (isUncertain(err)) {
      // Snapshot kept: "Try again" or a later reconcile reuses the same key.
      this.dispatch({ type: 'CREATE_FAILED', reason: retryReason(err) });
      return 'done';
    }
    if (isHttpError(err, 'QUOTE_STALE')) {
      await this.handleQuoteChanged(err.quote);
      return 'done';
    }
    if (isHttpError(err, 'ORDER_ALREADY_PAID')) {
      await this.handleOrderAlreadyPaid();
      return 'done';
    }
    if (isHttpError(err, 'ATTEMPT_IN_PROGRESS') && err.attempt) {
      // Another attempt for this order is processing (e.g. from a lost snapshot): follow it, never pay again.
      this.log('payment_duplicate_prevented', { attemptId: err.attempt.attemptId });
      await this.persist({
        ...this.snapshot!,
        attemptId: err.attempt.attemptId,
        clientAttemptId: err.attempt.clientAttemptId,
        method: err.attempt.method,
        phase: 'authorizing',
      });
      this.pendingToken = null;
      return 'reconcile';
    }
    if (isHttpError(err, 'METHOD_NOT_ELIGIBLE')) {
      await this.handleQuoteChanged(undefined);
      return 'done';
    }
    this.log('payment_create_rejected', { code: err instanceof ApiError ? err.code ?? err.message : 'unknown' });
    await this.clearSnapshot();
    this.dispatch({ type: 'RESET_TO_READY' });
    return 'done';
  }

  private async handleQuoteChanged(quote: OrderQuote | undefined): Promise<void> {
    await this.clearSnapshot();
    if (quote) {
      this.applyQuote(quote);
    } else {
      await this.loadOrder();
    }
    this.dispatch({ type: 'RESET_TO_READY', notice: 'quote_changed' });
  }

  private async handleOrderAlreadyPaid(): Promise<void> {
    const quote = await this.loadOrder();
    if (quote?.status === 'paid') {
      await this.showPaidOrder(quote);
      return;
    }
    await this.clearSnapshot();
    this.dispatch({ type: 'RESET_TO_READY' });
  }

  // ---------- Present (SPEC §6.2 step 4, §7) ----------

  private async present(attempt: Attempt): Promise<void> {
    const snap = this.snapshot!;
    const adapter = this.deps.adapters[snap.method];
    const ctx = { attemptId: attempt.attemptId, amount: attempt.amount };

    if (isWalletMethod(snap.method)) {
      this.dispatch({ type: 'WALLET_PRESENTED', attemptId: attempt.attemptId });
      this.log('provider_presented');
      let result;
      try {
        result = await adapter.present(ctx);
      } catch {
        result = { kind: 'cancelled' as const };
      }
      if (result.kind !== 'token') {
        this.log('provider_cancelled');
        await this.cancelQuietly(attempt.attemptId);
        await this.clearSnapshot();
        this.dispatch({ type: 'PAYMENT_CANCELLED' });
        return;
      }
      await this.authorizeAndSettle(attempt.attemptId, result.sourceToken);
      return;
    }

    if (snap.method === 'card') {
      const result = await adapter.present({ ...ctx, cardToken: this.pendingToken ?? undefined });
      if (result.kind !== 'token') {
        await this.cancelQuietly(attempt.attemptId);
        await this.clearSnapshot();
        this.dispatch({ type: 'RESET_TO_READY' });
        return;
      }
      await this.authorizeAndSettle(attempt.attemptId, result.sourceToken);
      return;
    }

    // Affirm: persist `redirected` before leaving the app; the result comes back via §6.3.
    await this.persist({ ...snap, phase: 'redirected' });
    this.dispatch({ type: 'AFFIRM_REDIRECTED', attemptId: attempt.attemptId });
    this.log('provider_presented');
    await this.openAffirm(attempt.attemptId, attempt.amount);
  }

  private async openAffirm(attemptId: string, amount: Attempt['amount']): Promise<void> {
    // Affirm runs outside the app: foregrounding must be free to reconcile.
    this.localOp = false;
    try {
      await this.deps.adapters.affirm.present({ attemptId, amount });
    } catch {
      await this.cancelQuietly(attemptId);
      await this.clearSnapshot();
      this.dispatch({ type: 'RESET_TO_READY', notice: 'payment_not_completed' });
    }
  }

  private async cancelQuietly(attemptId: string): Promise<void> {
    try {
      await this.deps.api.cancelAttempt(attemptId);
    } catch {
      // Harmless: the attempt was never authorized, and the next create cancels it server-side.
    }
  }

  // ---------- Authorize (SPEC §6.2 step 5) ----------

  private async authorizeAndSettle(attemptId: string, sourceToken: string): Promise<void> {
    if ((await this.authorizeOnce(attemptId, sourceToken)) === 'uncertain') {
      await this.reconcile('timeout');
    }
  }

  /**
   * Sends the authorize with the attempt's persisted key. A definitive answer is applied ('done');
   * anything else moves to `reconciling` ('uncertain'). It never creates a new key.
   */
  private async authorizeOnce(attemptId: string, sourceToken: string): Promise<StepResult> {
    const snap = this.snapshot!;
    this.pendingToken = sourceToken;
    await this.persist({ ...snap, phase: 'authorizing' });
    this.dispatch({ type: 'AUTHORIZE_STARTED', attemptId, method: snap.method });
    this.log('payment_authorization_started');
    const started = this.deps.now().getTime();

    try {
      const attempt = await this.deps.api.authorize(attemptId, snap.authorizeKey, sourceToken);
      const mapped = await this.mapAttempt(attempt);
      if (mapped === 'final') {
        return 'done';
      }
      this.dispatch({ type: 'RECONCILE_STARTED', attemptId, reason: 'processing' });
      return 'uncertain';
    } catch (err) {
      if (isHttpError(err, 'ATTEMPT_NOT_AUTHORIZABLE') && err.attempt) {
        if ((await this.mapAttempt(err.attempt)) === 'final') {
          return 'done';
        }
      } else if (isHttpError(err, 'QUOTE_STALE')) {
        await this.handleQuoteChanged(err.quote);
        return 'done';
      } else if (isHttpError(err, 'ORDER_ALREADY_PAID')) {
        await this.handleOrderAlreadyPaid();
        return 'done';
      }
      this.log('payment_authorization_unknown', {
        code: err instanceof ApiError ? err.code ?? err.kind : 'unknown',
        durationMs: this.deps.now().getTime() - started,
      });
      this.dispatch({ type: 'RECONCILE_STARTED', attemptId, reason: 'timeout' });
      return 'uncertain';
    }
  }

  /** Applies a server attempt status to the UI (SPEC §4.2 mapping). */
  private async mapAttempt(attempt: Attempt): Promise<Mapped> {
    switch (attempt.status) {
      case 'succeeded':
        // Update the UI first, then clear the snapshot (SPEC §6.2 step 5).
        this.dispatch({ type: 'PAYMENT_SUCCEEDED', attemptId: attempt.attemptId });
        this.log('payment_succeeded', { attemptId: attempt.attemptId, status: attempt.status });
        await this.clearSnapshot();
        this.loadOrder().catch(() => undefined); // refresh to `paid` in the background
        return 'final';
      case 'declined':
        this.dispatch({ type: 'PAYMENT_DECLINED', attemptId: attempt.attemptId, code: attempt.failureCode });
        this.log('payment_declined', { attemptId: attempt.attemptId, code: attempt.failureCode });
        await this.clearSnapshot();
        return 'final';
      case 'cancelled':
        if (attempt.failureCode === 'QUOTE_STALE') {
          await this.handleQuoteChanged(undefined);
        } else {
          await this.clearSnapshot();
          this.dispatch({ type: 'PAYMENT_CANCELLED' });
        }
        return 'final';
      case 'processing':
        return 'pending';
      case 'awaiting_user':
        return 'awaiting_user';
    }
  }

  // ---------- Reconcile (SPEC §6.4) ----------

  /** Single-flight: concurrent triggers share the same run. */
  reconcile(reason: ReconcileReason): Promise<void> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this.runReconcile(reason).finally(() => {
        this.reconcilePromise = null;
      });
    }
    return this.reconcilePromise;
  }

  /** "Check again" after the backoff ran out. */
  checkAgain(): Promise<void> {
    return this.state.tag === 'reconciling' ? this.reconcile('manual') : Promise.resolve();
  }

  private async runReconcile(reason: ReconcileReason): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    this.dispatch({ type: 'RECONCILE_STARTED', attemptId: this.snapshot.attemptId ?? undefined, reason });
    this.log('payment_reconciliation_started', { code: reason });
    let reauthorized = false;

    const delays = [0, ...this.backoffMs];
    for (const delay of delays) {
      if (delay > 0) {
        await this.deps.sleep(delay);
      }
      const snap = this.snapshot;
      if (!snap) {
        return;
      }

      // Step 1: the create may have landed without its response; replaying it recovers the attemptId.
      if (!snap.attemptId) {
        const recovered = await this.recoverAttemptId(snap);
        if (recovered === 'done') {
          return;
        }
        if (recovered === 'retry') {
          continue;
        }
      }
      const current = this.snapshot!;
      const attemptId = current.attemptId!;

      // Step 2: ask the server.
      let attempt: Attempt;
      try {
        attempt = await this.deps.api.getAttempt(attemptId);
      } catch (err) {
        if (isHttpError(err, 'ATTEMPT_NOT_FOUND')) {
          // The server has no record (e.g. demo reset): nothing was charged.
          await this.clearSnapshot();
          this.dispatch({ type: 'RESET_TO_READY', notice: 'payment_not_completed' });
          return;
        }
        continue;
      }

      // Step 3: map it.
      const mapped = await this.mapAttempt(attempt);
      if (mapped === 'final') {
        return;
      }
      if (mapped === 'pending') {
        continue;
      }
      if (current.phase === 'redirected') {
        this.dispatch({ type: 'RECONCILE_STARTED', attemptId, reason: 'affirm_pending' });
        return;
      }
      if (current.phase === 'authorizing' && this.pendingToken && !reauthorized) {
        // The app never died, so the token is still here: retry with the SAME key.
        reauthorized = true;
        if ((await this.authorizeOnce(attemptId, this.pendingToken)) === 'done') {
          return;
        }
        continue;
      }
      // The token is gone (cold start) or the attempt never got that far: cancel it.
      if ((await this.cancelForRecovery(attemptId)) === 'done') {
        return;
      }
    }
    this.dispatch({ type: 'RECONCILE_STARTED', attemptId: this.snapshot?.attemptId ?? undefined, reason: 'exhausted' });
  }

  private async recoverAttemptId(snap: AttemptSnapshot): Promise<'recovered' | 'retry' | 'done'> {
    try {
      const attempt = await this.deps.api.createAttempt(this.createBody(snap));
      await this.persist({
        ...snap,
        attemptId: attempt.attemptId,
        phase: snap.phase === 'creating' ? 'awaiting_user' : snap.phase,
      });
      return 'recovered';
    } catch (err) {
      if (isUncertain(err)) {
        return 'retry';
      }
      const next = await this.handleCreateError(err);
      // ATTEMPT_IN_PROGRESS switched the snapshot to the existing attempt: keep reconciling it.
      return next === 'reconcile' ? 'recovered' : 'done';
    }
  }

  /** Cancel is atomic and only works from `awaiting_user`, so it is safe after a lost token. */
  private async cancelForRecovery(attemptId: string): Promise<StepResult> {
    try {
      const attempt = await this.deps.api.cancelAttempt(attemptId);
      if (attempt.status === 'cancelled' && attempt.failureCode !== 'QUOTE_STALE') {
        await this.clearSnapshot();
        this.dispatch({ type: 'RESET_TO_READY', notice: 'payment_not_completed' });
        return 'done';
      }
      return (await this.mapAttempt(attempt)) === 'final' ? 'done' : 'uncertain';
    } catch {
      // 409 ATTEMPT_NOT_CANCELLABLE (now processing) or network: keep polling.
      return 'uncertain';
    }
  }

  // ---------- Affirm pending (SPEC §6.4) ----------

  async continueWithAffirm(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'reconciling' || this.state.reason !== 'affirm_pending' || !snap?.attemptId) {
      return;
    }
    this.dispatch({ type: 'AFFIRM_REDIRECTED', attemptId: snap.attemptId });
    await this.openAffirm(snap.attemptId, { currency: 'USD', minorUnits: snap.amountMinor });
  }

  async chooseAnotherMethod(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'reconciling' || this.state.reason !== 'affirm_pending' || !snap?.attemptId) {
      return;
    }
    try {
      const attempt = await this.deps.api.cancelAttempt(snap.attemptId);
      if (attempt.status === 'cancelled') {
        await this.clearSnapshot();
        this.dispatch({ type: 'RESET_TO_READY' });
        return;
      }
      // The user approved in the meantime: show what the server says.
      if ((await this.mapAttempt(attempt)) !== 'final') {
        await this.reconcile('manual');
      }
    } catch {
      await this.reconcile('manual');
    }
  }

  // ---------- Quantity (SPEC §2 "Total change", ORDER-01) ----------

  async changeQuantity(quantity: number): Promise<void> {
    if (!canChangeQuantity(this.state) || this.order.status !== 'loaded' || this.localOp || this.reconcilePromise) {
      return;
    }
    try {
      const quote = await this.deps.api.updateQuantity(this.deps.orderId, quantity);
      this.applyQuote(quote);
      if (this.snapshot) {
        // The server cancelled the pending Affirm attempt when the version changed.
        await this.clearSnapshot();
        this.dispatch({ type: 'RESET_TO_READY' });
      }
    } catch (err) {
      if (isHttpError(err, 'ORDER_ALREADY_PAID')) {
        await this.handleOrderAlreadyPaid();
      }
    }
  }

  // ---------- External signals (SPEC §6.3) ----------

  /** AppState became `active`. Skipped while a sheet or request is in flight in this process. */
  async onAppActive(): Promise<void> {
    await this.init();
    if (this.snapshot && !this.localOp) {
      await this.reconcile('app_resumed');
    }
  }

  /** Deep link return. The `result` parameter is only logged, never trusted. */
  async handleUrl(url: string): Promise<void> {
    const parsed = parseReturnUrl(url);
    if (!parsed) {
      return;
    }
    await this.init();
    this.log('deeplink_received', { attemptId: parsed.attemptId ?? undefined, code: parsed.result ?? undefined });
    if (!this.snapshot) {
      const quote = await this.loadOrder();
      if (quote?.status === 'paid' && this.state.tag !== 'succeeded') {
        await this.showPaidOrder(quote);
      }
      return;
    }
    if (parsed.attemptId !== this.snapshot.attemptId) {
      this.log('deeplink_mismatch', { attemptId: this.snapshot.attemptId ?? undefined });
    }
    if (!this.localOp) {
      await this.reconcile('deeplink');
    }
  }

  dismiss(): void {
    this.dispatch({ type: 'DISMISS' });
  }

  /** Dev menu "Reset demo" only: drops all client state after the server was reset. */
  async devReset(): Promise<void> {
    await this.clearSnapshot();
    this.localOp = false;
    this.state = initialCheckoutState;
    this.emit();
    await this.loadOrder();
  }
}
