// Test harness for the orchestrator: an in-memory fake server that follows the real contract
// (idempotent create, one authorize per attempt, cancel only from awaiting_user), plus fake
// storage, adapters and logger. Every interaction is recorded in `calls`, in order.

import type { Attempt, AttemptStatus, CreateAttemptRequest, OrderQuote, PaymentMethod } from '@shared';
import { ApiError, type PaymentApi } from '../../src/api/paymentApi';
import { createAttemptStore, type KeyValueStorage } from '../../src/checkout/attemptStore';
import { CheckoutOrchestrator } from '../../src/checkout/orchestrator';
import { createLogger, type LogEntry } from '../../src/logger';
import { createCardAdapter } from '../../src/payments/card';
import type { PaymentAdapter, PresentResult } from '../../src/payments/types';

export const NOW = new Date('2026-10-26T12:00:00.000Z');

export class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  /** Every value ever written, for the security sweep. */
  readonly writes: string[] = [];
  constructor(private readonly calls: string[]) {}
  async getItem(key: string) {
    this.calls.push('storage.getItem');
    return this.data.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.calls.push(`storage.setItem:${(JSON.parse(value) as { phase?: string }).phase ?? '?'}`);
    this.writes.push(value);
    this.data.set(key, value);
  }
  async removeItem(key: string) {
    this.calls.push('storage.removeItem');
    this.data.delete(key);
  }
}

const usd = (minorUnits: number) => ({ currency: 'USD' as const, minorUnits });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function http(status: number, code: string, extra: { attempt?: Attempt; quote?: OrderQuote } = {}): ApiError {
  return new ApiError({ kind: 'http', status, code: code as never, ...extra });
}

/** Behaves like the mock server for the cases the orchestrator cares about. */
export class FakeServer {
  quote: OrderQuote = {
    orderId: 'order_demo',
    version: 1,
    eventName: 'Bay City Comets vs. Harbor Kings',
    seatInfo: 'Section 112 · Row F',
    quantity: 2,
    unitPrice: usd(4250),
    feePerTicket: usd(925),
    subtotal: usd(8500),
    fees: usd(1850),
    total: usd(10350),
    status: 'open',
  };
  readonly attempts = new Map<string, Attempt>();
  private readonly byClientId = new Map<string, string>();
  private seq = 0;
  /** Outcome for the next authorize; `tok_test_decline` always declines. */
  nextOutcome: 'succeeded' | 'declined' | 'processing' = 'succeeded';
  readonly authorizeKeys: string[] = [];
  readonly authorizedAttempts: string[] = [];
  readonly createKeys: string[] = [];

  getOrder(): OrderQuote {
    return clone(this.quote);
  }

  bumpVersion(changes: Partial<OrderQuote> = {}): void {
    this.quote = { ...this.quote, ...changes, version: this.quote.version + 1 };
    for (const a of this.attempts.values()) {
      if (a.orderId === this.quote.orderId && a.status === 'awaiting_user') {
        a.status = 'cancelled';
        a.failureCode = 'QUOTE_STALE';
      }
    }
  }

  updateQuantity(quantity: number): OrderQuote {
    const total = quantity * (4250 + 925);
    this.bumpVersion({ quantity, subtotal: usd(quantity * 4250), fees: usd(quantity * 925), total: usd(total) });
    return this.getOrder();
  }

  create(body: CreateAttemptRequest): Attempt {
    this.createKeys.push(body.clientAttemptId);
    const existing = this.byClientId.get(body.clientAttemptId);
    if (existing) {
      return clone(this.attempts.get(existing)!);
    }
    if (this.quote.status === 'paid') {
      throw http(409, 'ORDER_ALREADY_PAID');
    }
    if (body.order.version !== this.quote.version || body.amount.minorUnits !== this.quote.total.minorUnits) {
      throw http(409, 'QUOTE_STALE', { quote: this.getOrder() });
    }
    for (const a of this.attempts.values()) {
      if (a.status === 'awaiting_user') {
        a.status = 'cancelled';
      }
    }
    const attempt: Attempt = {
      attemptId: `pat_${++this.seq}`,
      clientAttemptId: body.clientAttemptId,
      orderId: body.order.id,
      orderVersion: body.order.version,
      amount: body.amount,
      method: body.method,
      status: 'awaiting_user',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.attempts.set(attempt.attemptId, attempt);
    this.byClientId.set(body.clientAttemptId, attempt.attemptId);
    return clone(attempt);
  }

  authorize(attemptId: string, key: string, token: string): Attempt {
    this.authorizeKeys.push(key);
    const attempt = this.mustGet(attemptId);
    if (attempt.status !== 'awaiting_user') {
      throw http(409, 'ATTEMPT_NOT_AUTHORIZABLE', { attempt: clone(attempt) });
    }
    this.authorizedAttempts.push(attemptId);
    const outcome = token === 'tok_test_decline' ? 'declined' : this.nextOutcome;
    this.nextOutcome = 'succeeded';
    this.setStatus(attemptId, outcome);
    return clone(attempt);
  }

  /** What the Affirm page does when the user taps Approve/Cancel in the browser. */
  settleAffirm(attemptId: string, status: AttemptStatus): void {
    this.authorizedAttempts.push(attemptId);
    this.setStatus(attemptId, status);
  }

  setStatus(attemptId: string, status: AttemptStatus): void {
    const attempt = this.mustGet(attemptId);
    attempt.status = status;
    if (status === 'declined') {
      attempt.failureCode = attempt.method === 'affirm' ? 'AFFIRM_DECLINED' : 'CARD_DECLINED';
    }
    if (status === 'succeeded') {
      this.quote = { ...this.quote, status: 'paid', paidAttemptId: attemptId };
    }
  }

  cancel(attemptId: string): Attempt {
    const attempt = this.mustGet(attemptId);
    if (attempt.status === 'processing') {
      throw http(409, 'ATTEMPT_NOT_CANCELLABLE', { attempt: clone(attempt) });
    }
    if (attempt.status === 'awaiting_user') {
      attempt.status = 'cancelled';
    }
    return clone(attempt);
  }

  get(attemptId: string): Attempt {
    return clone(this.mustGet(attemptId));
  }

  private mustGet(attemptId: string): Attempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw http(404, 'ATTEMPT_NOT_FOUND');
    }
    return attempt;
  }
}

export type FakeApi = { [K in keyof PaymentApi]: PaymentApi[K] extends (...args: infer A) => infer R ? jest.Mock<R, A> : never };

export function createFakeApi(server: FakeServer, calls: string[]): FakeApi {
  return {
    getOrder: jest.fn(async (_orderId: string) => {
      calls.push('api.getOrder');
      return server.getOrder();
    }),
    updateQuantity: jest.fn(async (_orderId: string, quantity: number) => {
      calls.push('api.updateQuantity');
      return server.updateQuantity(quantity);
    }),
    createAttempt: jest.fn(async (body: CreateAttemptRequest) => {
      calls.push('api.createAttempt');
      return server.create(body);
    }),
    authorize: jest.fn(async (attemptId: string, key: string, token: string) => {
      calls.push('api.authorize');
      return server.authorize(attemptId, key, token);
    }),
    cancelAttempt: jest.fn(async (attemptId: string) => {
      calls.push('api.cancelAttempt');
      return server.cancel(attemptId);
    }),
    getAttempt: jest.fn(async (attemptId: string) => {
      calls.push('api.getAttempt');
      return server.get(attemptId);
    }),
    affirmCheckoutUrl: jest.fn((attemptId: string) => `http://test/mock/affirm/checkout?attemptId=${attemptId}`),
  };
}

export const timeout = () => new ApiError({ kind: 'timeout' });
export const networkError = () => new ApiError({ kind: 'network' });

/** A wallet sheet the test resolves by hand (confirm / cancel), or leaves open. */
export class FakeWalletSheet implements PaymentAdapter {
  private resolver: ((r: PresentResult) => void) | null = null;
  presented = 0;
  constructor(readonly method: PaymentMethod, private readonly calls: string[]) {}
  present(): Promise<PresentResult> {
    this.calls.push(`${this.method}.present`);
    this.presented++;
    return new Promise(resolve => {
      this.resolver = resolve;
    });
  }
  get isOpen(): boolean {
    return this.resolver !== null;
  }
  confirm(): void {
    this.resolver?.({ kind: 'token', sourceToken: this.method === 'apple_pay' ? 'tok_test_applepay' : 'tok_test_googlepay' });
    this.resolver = null;
  }
  cancel(): void {
    this.resolver?.({ kind: 'cancelled' });
    this.resolver = null;
  }
}

export class FakeAffirm implements PaymentAdapter {
  readonly method = 'affirm' as const;
  readonly opened: string[] = [];
  constructor(private readonly calls: string[]) {}
  async present(ctx: { attemptId: string }): Promise<PresentResult> {
    this.calls.push('affirm.open');
    this.opened.push(ctx.attemptId);
    return { kind: 'redirected' };
  }
}

/** Lets pending promise chains run (the fakes resolve on the microtask queue). */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

export type Harness = ReturnType<typeof makeHarness>;

// Deterministic and unique across harnesses that share storage (simulated app restarts).
let globalIds = 0;

export function makeHarness(shared: { server?: FakeServer; calls?: string[]; storage?: MemoryStorage } = {}) {
  const calls = shared.calls ?? [];
  const server = shared.server ?? new FakeServer();
  const storage = shared.storage ?? new MemoryStorage(calls);
  const logs: LogEntry[] = [];
  const logger = createLogger(entry => logs.push(entry), { platform: 'ios' });
  const api = createFakeApi(server, calls);
  const applePay = new FakeWalletSheet('apple_pay', calls);
  const googlePay = new FakeWalletSheet('google_pay', calls);
  const affirm = new FakeAffirm(calls);
  const sleeps: number[] = [];

  const orchestrator = new CheckoutOrchestrator({
    api,
    store: createAttemptStore(storage, logger),
    adapters: { apple_pay: applePay, google_pay: googlePay, affirm, card: createCardAdapter() },
    logger,
    orderId: 'order_demo',
    newId: () => `key-${++globalIds}`,
    now: () => NOW,
    sleep: async ms => {
      sleeps.push(ms);
    },
    isEligible: () => true,
  });

  const states: string[] = [];
  orchestrator.subscribe(() => {
    const view = orchestrator.getView();
    const label = view.state.tag === 'reconciling' ? `reconciling:${view.state.reason}` : view.state.tag;
    if (states[states.length - 1] !== label) {
      states.push(label);
    }
  });

  return {
    orchestrator,
    server,
    api,
    storage,
    calls,
    logs,
    sleeps,
    states,
    applePay,
    googlePay,
    affirm,
    view: () => orchestrator.getView(),
    snapshot: () => {
      const raw = storage.data.get('checkout.attempt.v1');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
  };
}
