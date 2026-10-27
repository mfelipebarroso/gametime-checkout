import { createCheckoutReducer, initialCheckoutState, transition } from '../src/domain/checkout.reducer';
import type { CheckoutAction, CheckoutState } from '../src/domain/checkout.types';
import { canChangeQuantity, hasActiveAttempt } from '../src/domain/checkout.types';

const A = 'pat_1';

function run(actions: CheckoutAction[], start: CheckoutState = initialCheckoutState): CheckoutState {
  const reducer = createCheckoutReducer();
  return actions.reduce(reducer, start);
}

const ALL_STATES: CheckoutState[] = [
  { tag: 'ready' },
  { tag: 'creating', method: 'card' },
  { tag: 'awaiting_wallet', method: 'apple_pay', attemptId: A },
  { tag: 'awaiting_affirm', attemptId: A },
  { tag: 'authorizing', method: 'card', attemptId: A },
  { tag: 'reconciling', attemptId: A, reason: 'timeout' },
  { tag: 'succeeded', attemptId: A },
  { tag: 'declined', attemptId: A, code: 'CARD_DECLINED' },
  { tag: 'cancelled' },
  { tag: 'retryable_error', reason: 'network' },
];

const ALL_ACTIONS: CheckoutAction[] = [
  { type: 'START_PAYMENT', method: 'card' },
  { type: 'WALLET_PRESENTED', attemptId: A },
  { type: 'AFFIRM_REDIRECTED', attemptId: A },
  { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
  { type: 'CREATE_FAILED', reason: 'network' },
  { type: 'RETRY', method: 'card' },
  { type: 'RECONCILE_STARTED', attemptId: A, reason: 'app_resumed' },
  { type: 'PAYMENT_SUCCEEDED', attemptId: A },
  { type: 'PAYMENT_DECLINED', attemptId: A, code: 'CARD_DECLINED' },
  { type: 'PAYMENT_CANCELLED' },
  { type: 'RESET_TO_READY' },
  { type: 'DISMISS' },
];

describe('valid flows', () => {
  test('card: ready → creating → authorizing → succeeded', () => {
    expect(
      run([
        { type: 'START_PAYMENT', method: 'card' },
        { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
        { type: 'PAYMENT_SUCCEEDED', attemptId: A },
      ]),
    ).toEqual({ tag: 'succeeded', attemptId: A });
  });

  test('wallet: creating → awaiting_wallet → authorizing (method comes from state)', () => {
    const s = run([
      { type: 'START_PAYMENT', method: 'google_pay' },
      { type: 'WALLET_PRESENTED', attemptId: A },
      { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
    ]);
    expect(s).toEqual({ tag: 'authorizing', method: 'google_pay', attemptId: A });
  });

  test('wallet cancelled → cancelled → DISMISS → ready', () => {
    const s = run([
      { type: 'START_PAYMENT', method: 'apple_pay' },
      { type: 'WALLET_PRESENTED', attemptId: A },
      { type: 'PAYMENT_CANCELLED' },
    ]);
    expect(s).toEqual({ tag: 'cancelled' });
    expect(run([{ type: 'DISMISS' }], s)).toEqual({ tag: 'ready' });
  });

  test('affirm: creating → awaiting_affirm → reconciling → succeeded', () => {
    expect(
      run([
        { type: 'START_PAYMENT', method: 'affirm' },
        { type: 'AFFIRM_REDIRECTED', attemptId: A },
        { type: 'RECONCILE_STARTED', attemptId: A, reason: 'deeplink' },
        { type: 'PAYMENT_SUCCEEDED', attemptId: A },
      ]),
    ).toEqual({ tag: 'succeeded', attemptId: A });
  });

  test('pending affirm: "Continue with Affirm" returns to awaiting_affirm', () => {
    const s: CheckoutState = { tag: 'reconciling', attemptId: A, reason: 'affirm_pending' };
    expect(run([{ type: 'AFFIRM_REDIRECTED', attemptId: A }], s)).toEqual({ tag: 'awaiting_affirm', attemptId: A });
    // Outside affirm_pending it does not reopen.
    expect(transition({ tag: 'reconciling', attemptId: A, reason: 'timeout' }, { type: 'AFFIRM_REDIRECTED', attemptId: A })).toBeNull();
  });

  test('declined → DISMISS → ready (the next attempt is new)', () => {
    const s = run([
      { type: 'START_PAYMENT', method: 'card' },
      { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
      { type: 'PAYMENT_DECLINED', attemptId: A, code: 'CARD_DECLINED' },
    ]);
    expect(s).toEqual({ tag: 'declined', attemptId: A, code: 'CARD_DECLINED' });
    expect(run([{ type: 'DISMISS' }], s)).toEqual({ tag: 'ready' });
  });

  test('create fails → retryable_error → RETRY → creating', () => {
    const s = run([
      { type: 'START_PAYMENT', method: 'card' },
      { type: 'CREATE_FAILED', reason: 'timeout' },
    ]);
    expect(s).toEqual({ tag: 'retryable_error', reason: 'timeout' });
    expect(run([{ type: 'RETRY', method: 'card' }], s)).toEqual({ tag: 'creating', method: 'card' });
  });

  test('authorize with no response → reconciling → authorize again (same key) → succeeded', () => {
    expect(
      run([
        { type: 'START_PAYMENT', method: 'card' },
        { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
        { type: 'RECONCILE_STARTED', attemptId: A, reason: 'timeout' },
        { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'card' },
        { type: 'PAYMENT_SUCCEEDED', attemptId: A },
      ]),
    ).toEqual({ tag: 'succeeded', attemptId: A });
  });

  test('cold start: ready → reconciling (no attemptId) → ready with notice', () => {
    const s = run([
      { type: 'RECONCILE_STARTED', reason: 'cold_start' },
      { type: 'RESET_TO_READY', notice: 'payment_not_completed' },
    ]);
    expect(s).toEqual({ tag: 'ready', notice: 'payment_not_completed' });
    expect(run([{ type: 'DISMISS' }], s)).toEqual({ tag: 'ready' });
  });

  test('QUOTE_STALE on create → ready with a total-changed notice', () => {
    expect(
      run([
        { type: 'START_PAYMENT', method: 'affirm' },
        { type: 'RESET_TO_READY', notice: 'quote_changed' },
      ]),
    ).toEqual({ tag: 'ready', notice: 'quote_changed' });
  });

  test('order already paid on open: ready → succeeded', () => {
    expect(run([{ type: 'PAYMENT_SUCCEEDED', attemptId: A }])).toEqual({ tag: 'succeeded', attemptId: A });
  });

  test('exhausted backoff stays in reconciling ("Check again"), never becomes declined', () => {
    const s = run(
      [{ type: 'RECONCILE_STARTED', attemptId: A, reason: 'exhausted' }],
      { tag: 'reconciling', attemptId: A, reason: 'timeout' },
    );
    expect(s).toEqual({ tag: 'reconciling', attemptId: A, reason: 'exhausted' });
  });
});

describe('guards', () => {
  test('START_PAYMENT outside ready is ignored (double tap)', () => {
    for (const state of ALL_STATES.filter(s => s.tag !== 'ready')) {
      expect(transition(state, { type: 'START_PAYMENT', method: 'card' })).toBeNull();
    }
    const twice = run([
      { type: 'START_PAYMENT', method: 'card' },
      { type: 'START_PAYMENT', method: 'affirm' },
    ]);
    expect(twice).toEqual({ tag: 'creating', method: 'card' });
  });

  test('succeeded is terminal: no action leaves it', () => {
    const succeeded: CheckoutState = { tag: 'succeeded', attemptId: A };
    for (const action of ALL_ACTIONS) {
      expect(transition(succeeded, action)).toBeNull();
    }
  });

  test('invalid action returns the same state and calls onInvalid without throwing', () => {
    const onInvalid = jest.fn();
    const reducer = createCheckoutReducer(onInvalid);
    const state: CheckoutState = { tag: 'ready' };
    const next = reducer(state, { type: 'PAYMENT_DECLINED', attemptId: A });
    expect(next).toBe(state);
    expect(onInvalid).toHaveBeenCalledWith(state, { type: 'PAYMENT_DECLINED', attemptId: A });
  });

  test('WALLET_PRESENTED only for wallet methods', () => {
    expect(transition({ tag: 'creating', method: 'card' }, { type: 'WALLET_PRESENTED', attemptId: A })).toBeNull();
    expect(transition({ tag: 'creating', method: 'affirm' }, { type: 'WALLET_PRESENTED', attemptId: A })).toBeNull();
  });

  test('AUTHORIZE_STARTED is invalid for affirm (Affirm authorizes on the server)', () => {
    expect(transition({ tag: 'creating', method: 'affirm' }, { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'affirm' })).toBeNull();
    expect(transition({ tag: 'awaiting_affirm', attemptId: A }, { type: 'AUTHORIZE_STARTED', attemptId: A, method: 'affirm' })).toBeNull();
  });

  test('declined does not become succeeded or reconciling', () => {
    const declined: CheckoutState = { tag: 'declined', attemptId: A };
    expect(transition(declined, { type: 'PAYMENT_SUCCEEDED', attemptId: A })).toBeNull();
    expect(transition(declined, { type: 'RECONCILE_STARTED', attemptId: A, reason: 'app_resumed' })).toBeNull();
  });

  test('ready does not accept a cancellation result without an attempt', () => {
    expect(transition({ tag: 'ready' }, { type: 'PAYMENT_CANCELLED' })).toBeNull();
  });
});

describe('hasActiveAttempt', () => {
  test.each(ALL_STATES.map(s => [s.tag, s] as const))('%s', (tag, state) => {
    const active = ['creating', 'awaiting_wallet', 'awaiting_affirm', 'authorizing', 'reconciling', 'retryable_error'];
    expect(hasActiveAttempt(state)).toBe(active.includes(tag));
  });
});

describe('canChangeQuantity', () => {
  test('only in ready and in affirm_pending', () => {
    for (const state of ALL_STATES) {
      expect(canChangeQuantity(state)).toBe(state.tag === 'ready');
    }
    expect(canChangeQuantity({ tag: 'reconciling', attemptId: A, reason: 'affirm_pending' })).toBe(true);
  });
});
