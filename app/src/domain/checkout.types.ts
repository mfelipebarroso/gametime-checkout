import type { FailureCode, PaymentMethod } from '@shared';

export type WalletMethod = Extract<PaymentMethod, 'apple_pay' | 'google_pay'>;

/** Short message shown in `ready` after returning from an interrupted flow. */
export type ReadyNotice = 'quote_changed' | 'payment_not_completed';

export type ReconcileReason =
  | 'timeout' // authorize/create got no response
  | 'processing' // server answered `processing`
  | 'app_resumed'
  | 'cold_start'
  | 'deeplink'
  | 'affirm_pending' // Affirm still `awaiting_user`: "Continue with Affirm" / "Choose another method"
  | 'exhausted'; // backoff exhausted: "Check again"

export type RetryReason = 'network' | 'timeout' | 'server';

export type CheckoutState =
  | { tag: 'ready'; notice?: ReadyNotice }
  | { tag: 'creating'; method: PaymentMethod }
  | { tag: 'awaiting_wallet'; method: WalletMethod; attemptId: string }
  | { tag: 'awaiting_affirm'; attemptId: string }
  | { tag: 'authorizing'; method: PaymentMethod; attemptId: string }
  | { tag: 'reconciling'; attemptId?: string; reason: ReconcileReason }
  | { tag: 'succeeded'; attemptId: string }
  | { tag: 'declined'; attemptId: string; code?: FailureCode }
  | { tag: 'cancelled' }
  | { tag: 'retryable_error'; reason: RetryReason };

export type CheckoutTag = CheckoutState['tag'];

export type CheckoutAction =
  | { type: 'START_PAYMENT'; method: PaymentMethod }
  | { type: 'WALLET_PRESENTED'; attemptId: string }
  | { type: 'AFFIRM_REDIRECTED'; attemptId: string }
  | { type: 'AUTHORIZE_STARTED'; attemptId: string; method: PaymentMethod }
  | { type: 'CREATE_FAILED'; reason: RetryReason }
  | { type: 'RETRY'; method: PaymentMethod }
  | { type: 'RECONCILE_STARTED'; attemptId?: string; reason: ReconcileReason }
  | { type: 'PAYMENT_SUCCEEDED'; attemptId: string }
  | { type: 'PAYMENT_DECLINED'; attemptId: string; code?: FailureCode }
  | { type: 'PAYMENT_CANCELLED' }
  | { type: 'RESET_TO_READY'; notice?: ReadyNotice }
  | { type: 'DISMISS' };

export function isWalletMethod(method: PaymentMethod): method is WalletMethod {
  return method === 'apple_pay' || method === 'google_pay';
}

/** An attempt is in progress: locks the quantity selector and the pay buttons. */
export function hasActiveAttempt(state: CheckoutState): boolean {
  return (
    state.tag === 'creating' ||
    state.tag === 'awaiting_wallet' ||
    state.tag === 'awaiting_affirm' ||
    state.tag === 'authorizing' ||
    state.tag === 'reconciling' ||
    state.tag === 'retryable_error'
  );
}
