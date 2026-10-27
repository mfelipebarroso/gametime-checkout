// The card number, CVC, expiry and payment tokens never reach storage or logs.

import { createAttemptStore, SNAPSHOT_KEY } from '../src/checkout/attemptStore';
import { validateCard } from '../src/domain/card';
import { createLogger, sanitize, type LogEntry } from '../src/logger';
import { tokenizeCard } from '../src/payments/card';
import { MemoryStorage, NOW, makeHarness, networkError, timeout, type Harness } from './support/checkoutHarness';

const PAN = '4242424242424242';
const CVC = '737';
const FORM = { number: '4242 4242 4242 4242', expiry: '12/30', cvc: CVC };
const DECLINE_FORM = { number: '4000 0000 0000 0002', expiry: '12/30', cvc: CVC };

function everythingWritten(h: Harness): string {
  return [...h.storage.writes, ...h.storage.data.values(), ...h.logs.map(entry => JSON.stringify(entry))].join('\n');
}

function expectClean(dump: string): void {
  expect(dump).not.toContain(PAN);
  expect(dump).not.toContain('4000000000000002');
  expect(dump).not.toContain(CVC);
  expect(dump).not.toContain('12/30');
  expect(dump).not.toContain('tok_test');
}

describe('card flow leaves no sensitive data behind', () => {
  test('tokenization only exposes brand and last 4', () => {
    expect(validateCard(FORM, NOW).valid).toBe(true);
    expect(tokenizeCard(FORM)).toBe('tok_test_visa_4242');
    expect(tokenizeCard(DECLINE_FORM)).toBe('tok_test_decline');
    expect(tokenizeCard({ ...FORM, number: '3782 822463 10005' })).toBe('tok_test_amex_0005');
  });

  test('success, decline, lost responses and a cold start: storage and logs stay clean', async () => {
    const h = makeHarness();
    await h.orchestrator.init();

    // Decline, then success.
    await h.orchestrator.startPayment('card', { cardToken: tokenizeCard(DECLINE_FORM) });
    expect(h.view().state.tag).toBe('declined');
    h.orchestrator.dismiss();

    // Create failures (retryable_error) followed by "Try again".
    h.api.createAttempt.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    await h.orchestrator.startPayment('card', { cardToken: tokenizeCard(FORM) });
    expect(h.view().state.tag).toBe('retryable_error');
    // Authorize timeout during the retry → reconciliation → same-key authorize.
    h.api.authorize.mockRejectedValueOnce(timeout());
    await h.orchestrator.retry();
    expect(h.view().state.tag).toBe('succeeded');

    expect(h.storage.writes.length).toBeGreaterThan(0);
    expectClean(everythingWritten(h));
  });

  test('snapshot mid-authorize holds only the allowed fields', async () => {
    const h = makeHarness();
    await h.orchestrator.init();
    h.api.authorize.mockImplementation(() => new Promise(() => undefined));
    h.orchestrator.startPayment('card', { cardToken: tokenizeCard(FORM) });
    await new Promise<void>(resolve => setImmediate(() => resolve()));

    const snapshot = h.snapshot()!;
    expect(Object.keys(snapshot).sort()).toEqual(
      ['amountMinor', 'attemptId', 'authorizeKey', 'clientAttemptId', 'method', 'orderId', 'orderVersion', 'phase', 'startedAt', 'v'].sort(),
    );
    expect(snapshot.phase).toBe('authorizing');
    expectClean(everythingWritten(h));
  });

  test('the store drops unexpected fields even if a caller passes them', async () => {
    const calls: string[] = [];
    const storage = new MemoryStorage(calls);
    const store = createAttemptStore(storage, createLogger(() => undefined));
    const polluted = {
      v: 1 as const,
      clientAttemptId: 'c1',
      authorizeKey: 'k1',
      attemptId: null,
      orderId: 'order_demo',
      orderVersion: 1,
      amountMinor: 10350,
      method: 'card' as const,
      phase: 'creating' as const,
      startedAt: NOW.toISOString(),
      sourceToken: 'tok_test_visa_4242',
      cardNumber: PAN,
      cvc: CVC,
    };
    await store.save(polluted);
    expectClean(storage.data.get(SNAPSHOT_KEY)!);
  });
});

describe('logger', () => {
  test('drops keys outside the allowlist and non-primitive values', () => {
    const entry = sanitize('payment_authorization_started', {
      method: 'card',
      sourceToken: 'tok_test_visa_4242',
      number: PAN,
      cvc: CVC,
      form: { number: PAN },
      body: '{"sourceToken":"tok_test_visa_4242"}',
      attemptId: 'pat_1',
    });
    expect(entry).toEqual({ event: 'payment_authorization_started', method: 'card', attemptId: 'pat_1' });
  });

  test('redacts runs of 12+ digits inside allowed fields', () => {
    const entries: LogEntry[] = [];
    const logger = createLogger(e => entries.push(e));
    logger.log('payment_declined', { code: `card ${PAN} failed`, attemptId: '123456789012' });
    expect(entries[0]).toEqual({ event: 'payment_declined', code: 'card [REDACTED] failed', attemptId: '[REDACTED]' });
  });

  test('11 digits are left alone', () => {
    expect(sanitize('payment_declined', { code: '12345678901' }).code).toBe('12345678901');
  });
});
