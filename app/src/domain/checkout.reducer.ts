// Checkout UI state machine. Pure: an invalid transition returns the same state and is reported through
// `onInvalid` (the orchestrator logs it as `invalid_transition`).

import { hasActiveAttempt, isWalletMethod, type CheckoutAction, type CheckoutState } from './checkout.types';

export const initialCheckoutState: CheckoutState = { tag: 'ready' };

/** Returns the next state, or `null` if the action is not valid in the current state. */
export function transition(state: CheckoutState, action: CheckoutAction): CheckoutState | null {
  // `succeeded` is terminal on screen.
  if (state.tag === 'succeeded') {
    return null;
  }
  const inFlight = hasActiveAttempt(state);

  switch (action.type) {
    case 'START_PAYMENT':
      // Only `ready` accepts it, so a double tap is blocked in the reducer itself.
      return state.tag === 'ready' ? { tag: 'creating', method: action.method } : null;

    case 'WALLET_PRESENTED':
      return state.tag === 'creating' && isWalletMethod(state.method)
        ? { tag: 'awaiting_wallet', method: state.method, attemptId: action.attemptId }
        : null;

    case 'AFFIRM_REDIRECTED': {
      const fromCreate = state.tag === 'creating' && state.method === 'affirm';
      // "Continue with Affirm" after coming back without finishing.
      const fromPending = state.tag === 'reconciling' && state.reason === 'affirm_pending';
      return fromCreate || fromPending ? { tag: 'awaiting_affirm', attemptId: action.attemptId } : null;
    }

    case 'AUTHORIZE_STARTED':
      if ((state.tag === 'creating' && state.method === 'card') || state.tag === 'awaiting_wallet') {
        return { tag: 'authorizing', method: state.method, attemptId: action.attemptId };
      }
      // Retried with the same key while the token is still in memory; `reconciling` doesn't know the method.
      return state.tag === 'reconciling' ? { tag: 'authorizing', method: action.method, attemptId: action.attemptId } : null;

    case 'CREATE_FAILED':
      return state.tag === 'creating' ? { tag: 'retryable_error', reason: action.reason } : null;

    case 'RETRY':
      // "Try again" repeats the create with the same key (the orchestrator owns the key).
      return state.tag === 'retryable_error' ? { tag: 'creating', method: action.method } : null;

    case 'RECONCILE_STARTED':
      return state.tag === 'ready' || inFlight ? { tag: 'reconciling', attemptId: action.attemptId, reason: action.reason } : null;

    case 'PAYMENT_SUCCEEDED':
      // `ready` too: opening the app on an already-paid order shows success.
      return state.tag === 'ready' || inFlight ? { tag: 'succeeded', attemptId: action.attemptId } : null;

    case 'PAYMENT_DECLINED':
      return inFlight ? { tag: 'declined', attemptId: action.attemptId, code: action.code } : null;

    case 'PAYMENT_CANCELLED':
      return inFlight ? { tag: 'cancelled' } : null;

    case 'RESET_TO_READY':
      return inFlight || state.tag === 'cancelled' || state.tag === 'ready' ? { tag: 'ready', notice: action.notice } : null;

    case 'DISMISS':
      // After a decline the next attempt is a new one, with new keys.
      if (state.tag === 'declined' || state.tag === 'cancelled' || (state.tag === 'ready' && state.notice)) {
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
