// Contract shared by the app and the server: types, constants and a few pure helpers.
// Nothing here may depend on React Native or Node.

// ---------- Money ----------

export type Currency = 'USD';
/** Always an integer, in cents. */
export type Money = { currency: Currency; minorUnits: number };

/** Affirm shows only when the total is strictly greater than this. Exactly $100.00 does not qualify. */
export const AFFIRM_MIN_EXCLUSIVE_MINOR = 10000;

/** 10350 → "$103.50". Display only, never do math with the result. */
export function formatUsd(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new Error('formatUsd expects integer minor units');
  }
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100).toString().padStart(2, '0');
  return `${sign}$${dollars}.${cents}`;
}

// ---------- Order ----------

export type OrderStatus = 'open' | 'paid';

export type OrderQuote = {
  orderId: string;
  version: number;
  eventName: string;
  seatInfo: string;
  quantity: number;
  unitPrice: Money;
  feePerTicket: Money;
  subtotal: Money;
  fees: Money;
  total: Money;
  status: OrderStatus;
  paidAttemptId?: string;
};

export const DEMO_ORDER_ID = 'order_demo';
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 4;

// ---------- Methods and attempts ----------

export type PaymentMethod = 'apple_pay' | 'google_pay' | 'affirm' | 'card';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['apple_pay', 'google_pay', 'affirm', 'card'];

export type AttemptStatus = 'awaiting_user' | 'processing' | 'succeeded' | 'declined' | 'cancelled';

export type FailureCode = 'CARD_DECLINED' | 'INSUFFICIENT_FUNDS' | 'AFFIRM_DECLINED' | 'QUOTE_STALE';

export type Attempt = {
  attemptId: string;
  clientAttemptId: string;
  orderId: string;
  orderVersion: number;
  amount: Money;
  method: PaymentMethod;
  status: AttemptStatus;
  failureCode?: FailureCode;
  createdAt: string;
  updatedAt: string;
};

/** Tokens the stubbed SDKs hand out. Card tokens look like `tok_test_<brand>_<last4>`. */
export const TEST_TOKENS = {
  applePay: 'tok_test_applepay',
  googlePay: 'tok_test_googlepay',
  /** The mock processor always declines this one (test card 4000 0000 0000 0002). */
  decline: 'tok_test_decline',
} as const;

// ---------- Requests ----------

export type UpdateOrderRequest = { quantity: number };

export type CreateAttemptRequest = {
  clientAttemptId: string;
  order: { id: string; version: number };
  amount: Money;
  method: PaymentMethod;
};

export type AuthorizeRequest = { sourceToken: string };

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

// ---------- Errors ----------

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'QUOTE_STALE'
  | 'ORDER_ALREADY_PAID'
  | 'ORDER_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_IN_PROGRESS'
  | 'ATTEMPT_NOT_AUTHORIZABLE'
  | 'ATTEMPT_NOT_CANCELLABLE'
  | 'METHOD_NOT_ELIGIBLE'
  | 'NOT_FOUND'
  | 'INTERNAL';

/** `quote` comes with QUOTE_STALE, `attempt` with attempt conflicts, so the client can recover without a GET. */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; attempt?: Attempt; quote?: OrderQuote };
};

// ---------- Mock controls (MOCK_MODE=1) ----------

export type MockOutcome = 'approve' | 'decline' | 'processing' | 'drop_response';
export type MockLatencyMs = 0 | 2000 | 8000;
export type MockScenario = { nextOutcome: MockOutcome; latencyMs: MockLatencyMs };

// ---------- Affirm return ----------

export const RETURN_URL_BASE = 'gametime-demo://payment/return';

export function returnUrl(attemptId: string, result?: 'approved' | 'cancelled'): string {
  const query = `attemptId=${encodeURIComponent(attemptId)}`;
  return `${RETURN_URL_BASE}?${result ? `${query}&result=${result}` : query}`;
}

// ---------- Logging ----------

/** Any run of 12+ digits (a card number, say) becomes [REDACTED]. A safety net on top of the allowlists. */
export function redact(value: string): string {
  return value.replace(/\d{12,}/g, '[REDACTED]');
}
