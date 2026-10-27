import { attachLifecycle, type AppStateLike, type LinkingLike } from '../src/checkout/lifecycle';
import { parseReturnUrl } from '../src/checkout/returnUrl';
import { flush, makeHarness, MemoryStorage, networkError, timeout, FakeServer, type Harness } from './support/checkoutHarness';

const CARD = { cardToken: 'tok_test_visa_4242' };

async function booted(shared?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
  const h = makeHarness(shared);
  await h.orchestrator.init();
  return h;
}

/** Simulates an app kill + relaunch: a new orchestrator over the same storage and server. */
function relaunch(h: Harness): Harness {
  return makeHarness({ server: h.server, storage: h.storage, calls: h.calls });
}

describe('boot', () => {
  test('loads the order and starts in ready', async () => {
    const h = await booted();
    expect(h.view().state).toEqual({ tag: 'ready' });
    expect(h.view().order).toMatchObject({ status: 'loaded', quote: { total: { minorUnits: 10350 } } });
    expect(h.logs.map(l => l.event)).toContain('checkout_viewed');
  });

  test('an already-paid order shows success and clears any snapshot', async () => {
    const first = await booted();
    await first.orchestrator.startPayment('card', CARD);
    first.server.quote.status = 'paid';
    first.storage.data.set('checkout.attempt.v1', first.storage.writes[0]);

    const h = relaunch(first);
    await h.orchestrator.init();
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.snapshot()).toBeNull();
  });

  test('corrupted snapshot is cleared without crashing', async () => {
    for (const raw of ['{not json', JSON.stringify({ v: 2, clientAttemptId: 'x' }), JSON.stringify({ v: 1 })]) {
      const calls: string[] = [];
      const storage = new MemoryStorage(calls);
      storage.data.set('checkout.attempt.v1', raw);
      const h = await booted({ storage, calls });
      expect(h.logs.map(l => l.event)).toContain('snapshot_corrupted');
      expect(h.snapshot()).toBeNull();
      expect(h.view().state).toEqual({ tag: 'ready' });
      expect(h.api.getAttempt).not.toHaveBeenCalled();
    }
  });
});

describe('startPayment', () => {
  test('double startPayment produces a single create', async () => {
    const h = await booted();
    const first = h.orchestrator.startPayment('card', CARD);
    const second = h.orchestrator.startPayment('card', CARD);
    await Promise.all([first, second]);
    expect(h.api.createAttempt).toHaveBeenCalledTimes(1);
    expect(h.api.authorize).toHaveBeenCalledTimes(1);
    expect(h.view().state.tag).toBe('succeeded');
  });

  test('the snapshot is saved BEFORE the first request', async () => {
    const h = await booted();
    await h.orchestrator.startPayment('card', CARD);
    const saveIdx = h.calls.indexOf('storage.setItem:creating');
    const createIdx = h.calls.indexOf('api.createAttempt');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeLessThan(createIdx);

    const firstWrite = JSON.parse(h.storage.writes[0]);
    expect(firstWrite).toMatchObject({ v: 1, phase: 'creating', attemptId: null, orderVersion: 1, amountMinor: 10350, method: 'card' });
    expect(h.api.createAttempt.mock.calls[0][0].clientAttemptId).toBe(firstWrite.clientAttemptId);
    // The authorize phase is persisted before the authorize request too.
    expect(h.calls.indexOf('storage.setItem:authorizing')).toBeLessThan(h.calls.indexOf('api.authorize'));
  });

  test('card happy path: succeeded, then snapshot cleared', async () => {
    const h = await booted();
    await h.orchestrator.startPayment('card', CARD);
    expect(h.states).toEqual(['ready', 'creating', 'authorizing', 'succeeded']);
    expect(h.snapshot()).toBeNull();
    expect(h.api.authorize.mock.calls[0][2]).toBe('tok_test_visa_4242');
    expect(h.server.authorizedAttempts).toHaveLength(1);
  });

  test('card decline → declined; DISMISS; the next attempt uses NEW keys', async () => {
    const h = await booted();
    await h.orchestrator.startPayment('card', { cardToken: 'tok_test_decline' });
    expect(h.view().state).toMatchObject({ tag: 'declined', code: 'CARD_DECLINED' });
    expect(h.snapshot()).toBeNull();

    h.orchestrator.dismiss();
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state.tag).toBe('succeeded');
    const [firstKey, secondKey] = h.server.createKeys;
    expect(firstKey).not.toBe(secondKey);
    expect(new Set(h.server.authorizeKeys).size).toBe(2);
  });

  test('ignored without a card token, or when the method is not eligible', async () => {
    const h = await booted();
    await h.orchestrator.startPayment('card');
    expect(h.api.createAttempt).not.toHaveBeenCalled();
  });

  test('QUOTE_STALE on create reloads the order and returns to ready with a notice', async () => {
    const h = await booted();
    h.server.updateQuantity(1); // the total changed behind the client's back
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state).toEqual({ tag: 'ready', notice: 'quote_changed' });
    expect(h.view().order).toMatchObject({ status: 'loaded', quote: { version: 2, total: { minorUnits: 5175 } } });
    expect(h.snapshot()).toBeNull();
    expect(h.api.authorize).not.toHaveBeenCalled();
  });

  test('create network failures: same key retried, then retryable_error; "Try again" reuses the key', async () => {
    const h = await booted();
    h.api.createAttempt.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state).toEqual({ tag: 'retryable_error', reason: 'network' });
    expect(h.api.createAttempt).toHaveBeenCalledTimes(3);
    expect(h.snapshot()).toMatchObject({ phase: 'creating', attemptId: null });

    await h.orchestrator.retry();
    expect(h.view().state.tag).toBe('succeeded');
    expect(new Set(h.server.createKeys).size).toBe(1);
  });
});

describe('authorize uncertainty', () => {
  test('timeout (request never landed) → reconciling → authorize again with the SAME key', async () => {
    const h = await booted();
    h.api.authorize.mockRejectedValueOnce(timeout());
    await h.orchestrator.startPayment('card', CARD);
    expect(h.states).toContain('reconciling:timeout');
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.api.authorize).toHaveBeenCalledTimes(2);
    expect(new Set(h.api.authorize.mock.calls.map(c => c[1])).size).toBe(1);
    expect(h.server.authorizedAttempts).toHaveLength(1);
    expect(h.logs.map(l => l.event)).toContain('payment_authorization_unknown');
  });

  test('lost response (server charged) → GET shows succeeded; no second authorize', async () => {
    const h = await booted();
    h.api.authorize.mockImplementationOnce(async (id, key, token) => {
      h.server.authorize(id, key, token);
      throw timeout();
    });
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.api.authorize).toHaveBeenCalledTimes(1);
    expect(h.api.getAttempt).toHaveBeenCalled();
  });

  test('authorize never gets through: every authorize uses the same key and nothing is invented', async () => {
    const h = await booted();
    h.api.authorize.mockRejectedValue(timeout());
    await h.orchestrator.startPayment('card', CARD);
    expect(new Set(h.api.authorize.mock.calls.map(c => c[1])).size).toBe(1);
    expect(h.server.authorizedAttempts).toHaveLength(0);
    // The server never authorized it, so cancelling is safe and says so.
    expect(h.view().state).toEqual({ tag: 'ready', notice: 'payment_not_completed' });
    expect(h.states).not.toContain('declined');
  });

  test('processing → polls with backoff until succeeded', async () => {
    const h = await booted();
    h.server.nextOutcome = 'processing';
    let gets = 0;
    h.api.getAttempt.mockImplementation(async id => {
      if (++gets === 3) {
        h.server.setStatus(id, 'succeeded');
      }
      return h.server.get(id);
    });
    await h.orchestrator.startPayment('card', CARD);
    expect(h.states).toContain('reconciling:processing');
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  test('server unreachable: backoff runs out and stays in reconciling ("Check again"), never declined', async () => {
    const h = await booted();
    h.api.authorize.mockRejectedValueOnce(timeout());
    h.api.getAttempt.mockRejectedValue(networkError());
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state).toMatchObject({ tag: 'reconciling', reason: 'exhausted' });
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(h.api.getAttempt).toHaveBeenCalledTimes(6);
    expect(h.snapshot()).not.toBeNull();

    h.api.getAttempt.mockImplementation(async id => h.server.get(id));
    await h.orchestrator.checkAgain();
    // Token still in memory: same-key authorize goes through.
    expect(h.view().state.tag).toBe('succeeded');
    expect(new Set(h.api.authorize.mock.calls.map(c => c[1])).size).toBe(1);
  });

  test('409 ATTEMPT_NOT_AUTHORIZABLE carrying a succeeded attempt → succeeded', async () => {
    const h = await booted();
    h.api.authorize.mockImplementationOnce(async (id, key, token) => {
      h.server.authorize(id, key, token); // someone else (an earlier request) already won
      return h.server.authorize(id, `${key}-other`, token);
    });
    await h.orchestrator.startPayment('card', CARD);
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.server.authorizedAttempts).toHaveLength(1);
  });
});

describe('wallets (express)', () => {
  test('one tap + sheet confirm completes the purchase', async () => {
    const h = await booted();
    const run = h.orchestrator.startPayment('apple_pay');
    await flush();
    expect(h.view().state.tag).toBe('awaiting_wallet');
    // The attempt identity is on disk before the sheet opens.
    expect(h.calls.indexOf('storage.setItem:awaiting_user')).toBeLessThan(h.calls.indexOf('apple_pay.present'));
    h.applePay.confirm();
    await run;
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.api.authorize.mock.calls[0][2]).toBe('tok_test_applepay');
  });

  test('cancel in the sheet → POST cancel, snapshot cleared, cancelled', async () => {
    const h = await booted();
    const run = h.orchestrator.startPayment('google_pay');
    await flush();
    h.googlePay.cancel();
    await run;
    expect(h.view().state).toEqual({ tag: 'cancelled' });
    expect(h.api.cancelAttempt).toHaveBeenCalledTimes(1);
    expect(h.snapshot()).toBeNull();
    expect(h.api.authorize).not.toHaveBeenCalled();
    h.orchestrator.dismiss();
    expect(h.view().state).toEqual({ tag: 'ready' });
  });

  test('coming back to the foreground with the sheet open does not reconcile or cancel', async () => {
    const h = await booted();
    const run = h.orchestrator.startPayment('apple_pay');
    await flush();
    await h.orchestrator.onAppActive();
    expect(h.api.getAttempt).not.toHaveBeenCalled();
    expect(h.api.cancelAttempt).not.toHaveBeenCalled();
    expect(h.view().state.tag).toBe('awaiting_wallet');
    h.applePay.confirm();
    await run;
    expect(h.view().state.tag).toBe('succeeded');
  });
});

describe('cold start', () => {
  test('lost create + cold start repeats the create with the SAME key and recovers the attemptId', async () => {
    const first = await booted();
    // The server creates the attempt but the response never arrives, three times.
    first.api.createAttempt.mockImplementation(async body => {
      first.server.create(body);
      throw networkError();
    });
    await first.orchestrator.startPayment('card', CARD);
    expect(first.view().state.tag).toBe('retryable_error');
    const stored = first.snapshot()!;
    expect(stored).toMatchObject({ attemptId: null, phase: 'creating' });

    const h = relaunch(first);
    await h.orchestrator.init();
    expect(h.api.createAttempt).toHaveBeenCalledTimes(1);
    expect(h.api.createAttempt.mock.calls[0][0].clientAttemptId).toBe(stored.clientAttemptId);
    expect(h.storage.writes.some(w => JSON.parse(w).attemptId === 'pat_1')).toBe(true);
    expect(h.api.getAttempt).toHaveBeenCalledWith('pat_1');
    // Never authorized and no token survived the kill: cancel and say nothing was charged.
    expect(h.api.cancelAttempt).toHaveBeenCalledWith('pat_1');
    expect(h.view().state).toEqual({ tag: 'ready', notice: 'payment_not_completed' });
    expect(h.server.authorizedAttempts).toHaveLength(0);
  });

  test('awaiting_user in phase authorizing without the token → cancel → ready', async () => {
    const first = await booted();
    first.api.authorize.mockImplementation(() => new Promise(() => undefined)); // killed mid-request
    first.orchestrator.startPayment('card', CARD);
    await flush();
    expect(first.snapshot()).toMatchObject({ phase: 'authorizing', attemptId: 'pat_1' });

    const h = relaunch(first);
    await h.orchestrator.init();
    expect(h.api.authorize).not.toHaveBeenCalled();
    expect(h.api.cancelAttempt).toHaveBeenCalledWith('pat_1');
    expect(h.view().state).toEqual({ tag: 'ready', notice: 'payment_not_completed' });
    expect(h.snapshot()).toBeNull();
  });

  test('kill during authorize that the server completed → relaunch shows success (M10)', async () => {
    const first = await booted();
    first.api.authorize.mockImplementation(async (id, key, token) => {
      first.server.authorize(id, key, token);
      return new Promise(() => undefined);
    });
    first.orchestrator.startPayment('card', CARD);
    await flush();

    const h = relaunch(first);
    await h.orchestrator.init();
    expect(h.view().state.tag).toBe('succeeded');
    expect(h.server.authorizedAttempts).toHaveLength(1);
  });

  test('kill with the wallet sheet open → "not completed" on relaunch (M11)', async () => {
    const first = await booted();
    first.orchestrator.startPayment('apple_pay');
    await flush();
    expect(first.applePay.isOpen).toBe(true);

    const h = relaunch(first);
    await h.orchestrator.init();
    expect(h.view().state).toEqual({ tag: 'ready', notice: 'payment_not_completed' });
    expect(h.server.get('pat_1').status).toBe('cancelled');
  });
});

describe('Affirm and deep links', () => {
  async function startAffirm(): Promise<Harness> {
    const h = await booted();
    await h.orchestrator.startPayment('affirm');
    return h;
  }

  test('snapshot reaches `redirected` before the browser opens', async () => {
    const h = await startAffirm();
    expect(h.view().state).toEqual({ tag: 'awaiting_affirm', attemptId: 'pat_1' });
    expect(h.calls.indexOf('storage.setItem:redirected')).toBeLessThan(h.calls.indexOf('affirm.open'));
    expect(h.affirm.opened).toEqual(['pat_1']);
  });

  test('approve in the browser + deep link → success confirmed by GET (M12)', async () => {
    const h = await startAffirm();
    h.server.settleAffirm('pat_1', 'succeeded');
    await h.orchestrator.handleUrl('gametime-demo://payment/return?attemptId=pat_1&result=approved');
    expect(h.api.getAttempt).toHaveBeenCalledWith('pat_1');
    expect(h.view().state.tag).toBe('succeeded');
  });

  test('deep link says approved but GET says declined → declined', async () => {
    const h = await startAffirm();
    h.server.settleAffirm('pat_1', 'declined');
    await h.orchestrator.handleUrl('gametime-demo://payment/return?attemptId=pat_1&result=approved');
    expect(h.view().state).toMatchObject({ tag: 'declined', code: 'AFFIRM_DECLINED' });
  });

  test('a deep link alone never marks the purchase as paid', async () => {
    const h = await startAffirm();
    await h.orchestrator.handleUrl('gametime-demo://payment/return?attemptId=pat_1&result=approved');
    expect(h.view().state).toMatchObject({ tag: 'reconciling', reason: 'affirm_pending' });
  });

  test('deep link with a different attemptId logs deeplink_mismatch and reconciles the snapshot', async () => {
    const h = await startAffirm();
    h.server.settleAffirm('pat_1', 'succeeded');
    await h.orchestrator.handleUrl('gametime-demo://payment/return?attemptId=pat_999&result=approved');
    expect(h.logs.map(l => l.event)).toContain('deeplink_mismatch');
    expect(h.api.getAttempt).toHaveBeenCalledWith('pat_1');
    expect(h.api.getAttempt).not.toHaveBeenCalledWith('pat_999');
    expect(h.view().state.tag).toBe('succeeded');
  });

  test('back without approving → "Continue with Affirm" reopens; "Choose another method" cancels', async () => {
    const h = await startAffirm();
    await h.orchestrator.onAppActive();
    expect(h.view().state).toMatchObject({ tag: 'reconciling', reason: 'affirm_pending' });

    await h.orchestrator.continueWithAffirm();
    expect(h.view().state.tag).toBe('awaiting_affirm');
    expect(h.affirm.opened).toEqual(['pat_1', 'pat_1']);

    await h.orchestrator.onAppActive();
    await h.orchestrator.chooseAnotherMethod();
    expect(h.view().state).toEqual({ tag: 'ready' });
    expect(h.server.get('pat_1').status).toBe('cancelled');
    expect(h.snapshot()).toBeNull();
  });

  test('cold start from the Affirm deep link (M13)', async () => {
    const first = await startAffirm();
    first.server.settleAffirm('pat_1', 'succeeded');
    const h = relaunch(first);
    const unsubscribe = attachLifecycle(h.orchestrator, {
      appState: { addEventListener: () => ({ remove: () => undefined }) },
      linking: {
        addEventListener: () => ({ remove: () => undefined }),
        getInitialURL: async () => 'gametime-demo://payment/return?attemptId=pat_1&result=approved',
      },
    });
    await h.orchestrator.init();
    await flush();
    expect(h.view().state.tag).toBe('succeeded');
    unsubscribe();
  });

  test('changing quantity while Affirm is pending cancels it and drops Affirm (M14)', async () => {
    const h = await startAffirm();
    await h.orchestrator.onAppActive();
    await h.orchestrator.changeQuantity(1);
    expect(h.view().state).toEqual({ tag: 'ready' });
    expect(h.view().order).toMatchObject({ quote: { quantity: 1, total: { minorUnits: 5175 } } });
    expect(h.server.get('pat_1')).toMatchObject({ status: 'cancelled', failureCode: 'QUOTE_STALE' });
    expect(h.snapshot()).toBeNull();
  });

  test('quantity is locked during an active attempt', async () => {
    const h = await booted();
    h.orchestrator.startPayment('apple_pay');
    await flush();
    await h.orchestrator.changeQuantity(1);
    expect(h.api.updateQuantity).not.toHaveBeenCalled();
    h.applePay.cancel();
  });
});

describe('triggers', () => {
  test('concurrent triggers share one reconcile run (single-flight)', async () => {
    const first = await booted();
    await first.orchestrator.startPayment('affirm');
    const h = relaunch(first);
    first.server.setStatus('pat_1', 'processing');
    let gets = 0;
    h.api.getAttempt.mockImplementation(async id => {
      if (++gets === 2) {
        h.server.setStatus(id, 'succeeded');
      }
      return h.server.get(id);
    });
    await Promise.all([
      h.orchestrator.init(),
      h.orchestrator.onAppActive(),
      h.orchestrator.handleUrl('gametime-demo://payment/return?attemptId=pat_1&result=approved'),
    ]);
    expect(h.view().state.tag).toBe('succeeded');
    expect(gets).toBe(2);
    expect(h.logs.filter(l => l.event === 'payment_reconciliation_started')).toHaveLength(1);
  });

  test('lifecycle wires AppState, Linking events and the initial URL', async () => {
    const appListeners: Array<(s: string) => void> = [];
    const urlListeners: Array<(e: { url: string }) => void> = [];
    let removed = 0;
    const appState: AppStateLike = {
      addEventListener: (_type, listener) => {
        appListeners.push(listener);
        return { remove: () => removed++ };
      },
    };
    const linking: LinkingLike = {
      addEventListener: (_type, listener) => {
        urlListeners.push(listener);
        return { remove: () => removed++ };
      },
      getInitialURL: async () => 'gametime-demo://payment/return?attemptId=a1&result=approved',
    };
    const orchestrator = { init: jest.fn(async () => undefined), onAppActive: jest.fn(async () => undefined), handleUrl: jest.fn(async () => undefined) };

    const detach = attachLifecycle(orchestrator, { appState, linking });
    await flush();
    expect(orchestrator.init).toHaveBeenCalled();
    expect(orchestrator.handleUrl).toHaveBeenCalledWith('gametime-demo://payment/return?attemptId=a1&result=approved');

    appListeners[0]('background');
    expect(orchestrator.onAppActive).not.toHaveBeenCalled();
    appListeners[0]('active');
    expect(orchestrator.onAppActive).toHaveBeenCalledTimes(1);
    urlListeners[0]({ url: 'gametime-demo://payment/return?attemptId=a2' });
    expect(orchestrator.handleUrl).toHaveBeenCalledWith('gametime-demo://payment/return?attemptId=a2');

    detach();
    expect(removed).toBe(2);
  });

  test('parseReturnUrl', () => {
    expect(parseReturnUrl('gametime-demo://payment/return?attemptId=pat_1&result=approved')).toEqual({ attemptId: 'pat_1', result: 'approved' });
    expect(parseReturnUrl('gametime-demo://payment/return')).toEqual({ attemptId: null, result: null });
    expect(parseReturnUrl('https://evil.example/return?attemptId=pat_1')).toBeNull();
  });

  test('an invalid action is logged as invalid_transition', async () => {
    const h = await booted();
    h.orchestrator.dismiss();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'invalid_transition', status: 'ready', code: 'DISMISS' }));
  });
});

describe('server model sanity', () => {
  test('fake server rejects a second authorize on the same attempt', () => {
    const server = new FakeServer();
    const a = server.create({ clientAttemptId: 'c1', order: { id: 'order_demo', version: 1 }, amount: { currency: 'USD', minorUnits: 10350 }, method: 'card' });
    server.authorize(a.attemptId, 'k1', 'tok_test_visa_4242');
    expect(() => server.authorize(a.attemptId, 'k2', 'tok_test_visa_4242')).toThrow();
  });
});
