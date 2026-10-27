// Checkout UI state machine (SPEC §4.2). Pure: invalid transitions return the same state and are
// reported through `onInvalid` (the caller logs `invalid_transition`).

import { isWalletMethod, type CheckoutAction, type CheckoutState, type CheckoutTag } from './checkout.types';

export const initialCheckoutState: CheckoutState = { tag: 'ready' };

/** States in which a server result (success, decline, cancellation) can arrive. */
const IN_FLIGHT: readonly CheckoutTag[] = [
  'creating',
  'awaiting_wallet',
  'awaiting_affirm',
  'authorizing',
  'reconciling',
  'retryable_error',
];

function isIn(state: CheckoutState, tags: readonly CheckoutTag[]): boolean {
  return tags.includes(state.tag);
}

/** Returns the next state, or `null` if the action is not valid in the current state. */
export function transition(state: CheckoutState, action: CheckoutAction): CheckoutState | null {
  // `succeeded` is terminal on screen.
  if (state.tag === 'succeeded') {
    return null;
  }

  switch (action.type) {
    case 'START_PAYMENT':
      // Only `ready` accepts it: blocks double taps in the reducer itself.
      return state.tag === 'ready' ? { tag: 'creating', method: action.method } : null;

    case 'WALLET_PRESENTED':
      return state.tag === 'creating' && isWalletMethod(state.method)
        ? { tag: 'awaiting_wallet', method: state.method, attemptId: action.attemptId }
        : null;

    case 'AFFIRM_REDIRECTED':
      if (state.tag === 'creating' && state.method === 'affirm') {
        return { tag: 'awaiting_affirm', attemptId: action.attemptId };
      }
      // "Continue with Affirm" from reconciliation.
      if (state.tag === 'reconciling' && state.reason === 'affirm_pending') {
        return { tag: 'awaiting_affirm', attemptId: action.attemptId };
      }
      return null;

    case 'AUTHORIZE_STARTED':
      if (state.tag === 'creating' && state.method === 'card') {
        return { tag: 'authorizing', method: state.method, attemptId: action.attemptId };
      }
      if (state.tag === 'awaiting_wallet') {
        return { tag: 'authorizing', method: state.method, attemptId: action.attemptId };
      }
      // Authorize retried with the same key while the token is still in memory (SPEC §6.4).
      if (state.tag === 'reconciling') {
        return { tag: 'authorizing', method: action.method, attemptId: action.attemptId };
      }
      return null;

    case 'CREATE_FAILED':
      return state.tag === 'creating' ? { tag: 'retryable_error', reason: action.reason } : null;

    case 'RETRY':
      // "Try again" repeats the create with the SAME key (the orchestrator owns the key).
      return state.tag === 'retryable_error' ? { tag: 'creating', method: action.method } : null;

    case 'RECONCILE_STARTED':
      return state.tag === 'ready' || isIn(state, IN_FLIGHT)
        ? { tag: 'reconciling', attemptId: action.attemptId, reason: action.reason }
        : null;

    case 'PAYMENT_SUCCEEDED':
      // `ready` included: on open, an already-paid order shows success.
      return state.tag === 'ready' || isIn(state, IN_FLIGHT) ? { tag: 'succeeded', attemptId: action.attemptId } : null;

    case 'PAYMENT_DECLINED':
      return isIn(state, IN_FLIGHT) ? { tag: 'declined', attemptId: action.attemptId, code: action.code } : null;

    case 'PAYMENT_CANCELLED':
      return isIn(state, IN_FLIGHT) ? { tag: 'cancelled' } : null;

    case 'RESET_TO_READY':
      return isIn(state, IN_FLIGHT) || state.tag === 'cancelled' || state.tag === 'ready'
        ? { tag: 'ready', notice: action.notice }
        : null;

    case 'DISMISS':
      // `declined` → `ready`: the next attempt is new, with new keys.
      if (state.tag === 'declined' || state.tag === 'cancelled') {
        return { tag: 'ready' };
      }
      if (state.tag === 'ready' && state.notice) {
        return { tag: 'ready' };
      }
      return null;
  }
}

export function createCheckoutReducer(onInvalid?: (state: CheckoutState, action: CheckoutAction) => void) {
  return function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
    const next = transition(state, action);
    if (next === null) {
      onInvalid?.(state, action);
      return state;
    }
    return next;
  };
}

export const checkoutReducer = createCheckoutReducer();
