// Checkout orchestrator: owns the UI state machine, the persisted attempt snapshot and every payment
// request. The rules it keeps:
// - the snapshot is saved before any request and before opening a sheet or browser;
// - uncertainty (timeout, network, 5xx, lost response) leads to reconciliation, never to a new key;
// - deep links, sheet results and foregrounding are only signals; the server decides the outcome.

import type { Attempt, CreateAttemptRequest, OrderQuote, PaymentMethod } from '@shared';
import { ApiError, isHttpError, isUncertain, type PaymentApi } from '../api/paymentApi';
import { createCheckoutReducer, initialCheckoutState } from '../domain/checkout.reducer';
import {
  canChangeQuantity,
  isWalletMethod,
  type CheckoutAction,
  type CheckoutState,
  type ReadyNotice,
  type ReconcileReason,
  type RetryReason,
} from '../domain/checkout.types';
import type { LogEvent, Logger } from '../logger';
import type { PaymentAdapter, PresentResult } from '../payments/types';
import type { AttemptSnapshot, AttemptStore } from './attemptStore';
import { parseReturnUrl } from './returnUrl';

export type OrderLoad = { status: 'loading' } | { status: 'loaded'; quote: OrderQuote } | { status: 'error' };

export type CheckoutView = { state: CheckoutState; order: OrderLoad };

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
  /** Delays between reconciliation GETs. */
  backoffMs?: readonly number[];
  /** Pause between same-key create retries. */
  createRetryDelayMs?: number;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000] as const;
const CREATE_ATTEMPTS = 3; // first try + 2 retries with the same key

type Mapped = 'final' | 'pending' | 'awaiting_user';
type StepResult = 'done' | 'uncertain';

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
  /** Memory only, never persisted. Lets reconciliation retry the authorize with the same key. */
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
    this.view = { state: this.state, order: this.order };
  }

  // ---------- Store interface (useSyncExternalStore) ----------

  getView = (): CheckoutView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.view = { state: this.state, order: this.order };
    this.listeners.forEach(listener => listener());
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
      ...(s && { attemptId: s.attemptId ?? undefined, clientAttemptId: s.clientAttemptId, method: s.method, phase: s.phase, orderVersion: s.orderVersion }),
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

  /** Forgets the local attempt and goes back to `ready`. */
  private async resetToReady(notice?: ReadyNotice): Promise<void> {
    await this.clearSnapshot();
    this.dispatch({ type: 'RESET_TO_READY', notice });
  }

  /**
   * Cancels an attempt that was never authorized, then forgets it. A failed cancel is harmless: the
   * next create cancels it on the server anyway.
   */
  private async discardAttempt(attemptId: string | null): Promise<void> {
    if (attemptId) {
      await this.deps.api.cancelAttempt(attemptId).catch(() => undefined);
    }
    await this.clearSnapshot();
  }

  /** Marks a create/authorize/sheet as running in this process, so foregrounding doesn't reconcile over it. */
  private async withLocalOp(work: () => Promise<void>): Promise<void> {
    this.localOp = true;
    try {
      await work();
    } finally {
      this.localOp = false;
    }
  }

  // ---------- Boot and order ----------

  /** Cold start: load the snapshot and the order, and reconcile before enabling any action. */
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

  /** "Try again" after the order failed to load. */
  async refreshOrder(): Promise<void> {
    await this.loadOrder();
  }

  private async showPaidOrder(quote: OrderQuote): Promise<void> {
    this.dispatch({ type: 'PAYMENT_SUCCEEDED', attemptId: quote.paidAttemptId ?? this.snapshot?.attemptId ?? 'unknown' });
    if (this.snapshot) {
      await this.clearSnapshot();
    }
  }

  // ---------- Start payment ----------

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

    await this.withLocalOp(async () => {
      this.pendingToken = method === 'card' ? options.cardToken ?? null : null;
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
        // Without a persisted identity nothing may be sent.
        await this.resetToReady();
        return;
      }
      await this.runCreate();
    });
  }

  /** "Try again" from retryable_error: repeats the create with the same key. */
  async retry(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'retryable_error' || !snap || this.localOp) {
      return;
    }
    this.dispatch({ type: 'RETRY', method: snap.method });
    await this.withLocalOp(() => this.runCreate());
  }

  /** Gives up from retryable_error. Safe: an `awaiting_user` attempt is never authorized without a token. */
  async abandon(): Promise<void> {
    const snap = this.snapshot;
    if (this.state.tag !== 'retryable_error' || !snap) {
      return;
    }
    await this.discardAttempt(snap.attemptId);
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
      if ((await this.handleCreateError(lastError)) === 'reconcile') {
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
    await this.resetToReady();
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
    } else {
      await this.resetToReady();
    }
  }

  // ---------- Present ----------

  private async present(attempt: Attempt): Promise<void> {
    const { attemptId, amount } = attempt;
    const method = this.snapshot!.method;

    if (method === 'affirm') {
      // Persist `redirected` before leaving the app; the result comes back through a deep link or AppState.
      await this.persist({ ...this.snapshot!, phase: 'redirected' });
      this.dispatch({ type: 'AFFIRM_REDIRECTED', attemptId });
      this.log('provider_presented');
      await this.openAffirm(attemptId, amount);
      return;
    }

    const wallet = isWalletMethod(method);
    if (wallet) {
      this.dispatch({ type: 'WALLET_PRESENTED', attemptId });
      this.log('provider_presented');
    }
    const result = await this.deps.adapters[method]
      .present({ attemptId, amount, cardToken: this.pendingToken ?? undefined })
      .catch((): PresentResult => ({ kind: 'cancelled' }));

    if (result.kind !== 'token') {
      if (wallet) {
        this.log('provider_cancelled');
      }
      await this.discardAttempt(attemptId);
      this.dispatch(wallet ? { type: 'PAYMENT_CANCELLED' } : { type: 'RESET_TO_READY' });
      return;
    }
    if ((await this.authorizeOnce(attemptId, result.sourceToken)) === 'uncertain') {
      await this.reconcile('timeout');
    }
  }

  private async openAffirm(attemptId: string, amount: Attempt['amount']): Promise<void> {
    // Affirm runs outside the app, so foregrounding must be free to reconcile.
    this.localOp = false;
    try {
      await this.deps.adapters.affirm.present({ attemptId, amount });
    } catch {
      await this.discardAttempt(attemptId);
      this.dispatch({ type: 'RESET_TO_READY', notice: 'payment_not_completed' });
    }
  }

  // ---------- Authorize ----------

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
      if ((await this.mapAttempt(attempt)) === 'final') {
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

  /** Applies a server attempt status to the UI. */
  private async mapAttempt(attempt: Attempt): Promise<Mapped> {
    const { attemptId, status, failureCode } = attempt;
    switch (status) {
      case 'succeeded':
        // Update the UI first, then clear the snapshot.
        this.dispatch({ type: 'PAYMENT_SUCCEEDED', attemptId });
        this.log('payment_succeeded', { attemptId, status });
        await this.clearSnapshot();
        this.loadOrder().catch(() => undefined); // refresh to `paid` in the background
        return 'final';
      case 'declined':
        this.dispatch({ type: 'PAYMENT_DECLINED', attemptId, code: failureCode });
        this.log('payment_declined', { attemptId, code: failureCode });
        await this.clearSnapshot();
        return 'final';
      case 'cancelled':
        if (failureCode === 'QUOTE_STALE') {
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

  // ---------- Reconcile ----------

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

    for (const delay of [0, ...this.backoffMs]) {
      if (delay > 0) {
        await this.deps.sleep(delay);
      }
      const snap = this.snapshot;
      if (!snap) {
        return;
      }

      // The create may have landed without its response; replaying it recovers the attemptId.
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

      let attempt: Attempt;
      try {
        attempt = await this.deps.api.getAttempt(attemptId);
      } catch (err) {
        if (isHttpError(err, 'ATTEMPT_NOT_FOUND')) {
          // The server has no record (e.g. after a demo reset): nothing was charged.
          await this.resetToReady('payment_not_completed');
          return;
        }
        continue;
      }

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
        // The app never died, so the token is still here: retry with the same key.
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
      // ATTEMPT_IN_PROGRESS switched the snapshot to the existing attempt: keep reconciling that one.
      return (await this.handleCreateError(err)) === 'reconcile' ? 'recovered' : 'done';
    }
  }

  /** Cancel is atomic and only works from `awaiting_user`, so it is safe after a lost token. */
  private async cancelForRecovery(attemptId: string): Promise<StepResult> {
    try {
      const attempt = await this.deps.api.cancelAttempt(attemptId);
      if (attempt.status === 'cancelled' && attempt.failureCode !== 'QUOTE_STALE') {
        await this.resetToReady('payment_not_completed');
        return 'done';
      }
      return (await this.mapAttempt(attempt)) === 'final' ? 'done' : 'uncertain';
    } catch {
      // 409 ATTEMPT_NOT_CANCELLABLE (now processing) or network: keep polling.
      return 'uncertain';
    }
  }

  // ---------- Affirm pending ----------

  /** The Affirm attempt the fan came back from without finishing, if that is where we are. */
  private pendingAffirmAttemptId(): string | null {
    const pending = this.state.tag === 'reconciling' && this.state.reason === 'affirm_pending';
    return pending ? this.snapshot?.attemptId ?? null : null;
  }

  async continueWithAffirm(): Promise<void> {
    const attemptId = this.pendingAffirmAttemptId();
    if (!attemptId) {
      return;
    }
    this.dispatch({ type: 'AFFIRM_REDIRECTED', attemptId });
    await this.openAffirm(attemptId, { currency: 'USD', minorUnits: this.snapshot!.amountMinor });
  }

  async chooseAnotherMethod(): Promise<void> {
    const attemptId = this.pendingAffirmAttemptId();
    if (!attemptId) {
      return;
    }
    try {
      const attempt = await this.deps.api.cancelAttempt(attemptId);
      if (attempt.status === 'cancelled') {
        await this.resetToReady();
        return;
      }
      // The fan approved in the meantime: show what the server says.
      if ((await this.mapAttempt(attempt)) !== 'final') {
        await this.reconcile('manual');
      }
    } catch {
      await this.reconcile('manual');
    }
  }

  // ---------- Quantity ----------

  async changeQuantity(quantity: number): Promise<void> {
    if (!canChangeQuantity(this.state) || this.order.status !== 'loaded' || this.localOp || this.reconcilePromise) {
      return;
    }
    try {
      const quote = await this.deps.api.updateQuantity(this.deps.orderId, quantity);
      this.applyQuote(quote);
      if (this.snapshot) {
        // The server cancelled the pending Affirm attempt when the version changed.
        await this.resetToReady();
      }
    } catch (err) {
      if (isHttpError(err, 'ORDER_ALREADY_PAID')) {
        await this.handleOrderAlreadyPaid();
      }
    }
  }

  // ---------- External signals ----------

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
}
