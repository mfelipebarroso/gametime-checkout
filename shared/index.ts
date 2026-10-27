// Contract types and constants shared by app and server (SPEC §1, §2, §4.1, §5).
// Types and constants only: nothing here may depend on the app or server runtime.

export const CONTRACT_VERSION = 1;

// ---------- Money (SPEC §1) ----------

export type Currency = 'USD';
/** Always an integer, in cents. */
export type Money = { currency: Currency; minorUnits: number };

/** Affirm shows only when total > this value (strictly greater). Exactly $100.00 does not show Affirm. */
export const AFFIRM_MIN_EXCLUSIVE_MINOR = 10000;

// ---------- Order (SPEC §1) ----------

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

// ---------- Methods and attempts (SPEC §2, §4.1, §5) ----------

export type PaymentMethod = 'apple_pay' | 'google_pay' | 'affirm' | 'card';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['apple_pay', 'google_pay', 'affirm', 'card'];

export type AttemptStatus = 'awaiting_user' | 'processing' | 'succeeded' | 'declined' | 'cancelled';
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['succeeded', 'declined', 'cancelled'];

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

// ---------- Requests (SPEC §5) ----------

export type UpdateOrderRequest = { quantity: number };

export type CreateAttemptRequest = {
  clientAttemptId: string;
  order: { id: string; version: number };
  amount: Money;
  method: PaymentMethod;
};

export type AuthorizeRequest = { sourceToken: string };

// ---------- Errors (SPEC §5) ----------

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

/** `quote` comes with QUOTE_STALE; `attempt` with attempt conflicts (see DECISIONS, phase 0). */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; attempt?: Attempt; quote?: OrderQuote };
};

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

// ---------- Mock (SPEC §5.7) ----------

export type MockOutcome = 'approve' | 'decline' | 'processing' | 'drop_response';
export type MockLatencyMs = 0 | 2000 | 8000;
export type MockScenarioRequest = { nextOutcome?: MockOutcome; latencyMs?: MockLatencyMs };
export type MockTotalOverrideMinor = 9999 | 10000 | 10001 | 15000 | null;
export type MockOrderRequest = { totalOverrideMinor: MockTotalOverrideMinor };

export const RETURN_URL_BASE = 'gametime-demo://payment/return';
