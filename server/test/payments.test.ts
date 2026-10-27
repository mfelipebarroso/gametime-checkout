import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { authorize, countAuthorizations, createAttempt, createBody, getOrder, makeHarness, type Harness } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

describe('order', () => {
  test('qty 2 = $103.50; qty 1 = $51.75', async () => {
    const quote = await getOrder(h);
    expect(quote).toMatchObject({ quantity: 2, total: { currency: 'USD', minorUnits: 10350 }, status: 'open', version: 1 });
    const res = await h.api().put('/v1/orders/order_demo').send({ quantity: 1 }).expect(200);
    expect(res.body).toMatchObject({ quantity: 1, version: 2, total: { minorUnits: 5175 } });
  });

  test('quantity outside 1..4 → 422', async () => {
    await h.api().put('/v1/orders/order_demo').send({ quantity: 5 }).expect(422);
  });

  test('PUT cancels awaiting_user attempts', async () => {
    const attempt = await createAttempt(h);
    await h.api().put('/v1/orders/order_demo').send({ quantity: 1 }).expect(200);
    const res = await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
    expect(res.body).toMatchObject({ status: 'cancelled', failureCode: 'QUOTE_STALE' });
  });
});

describe('basic flow', () => {
  test('create → authorize → GET approved; order becomes paid', async () => {
    const attempt = await createAttempt(h);
    expect(attempt).toMatchObject({ status: 'awaiting_user', amount: { minorUnits: 10350 }, orderVersion: 1 });
    expect(attempt.attemptId).toMatch(/^pat_/);

    const auth = await authorize(h, attempt.attemptId).expect(200);
    expect(auth.body.status).toBe('succeeded');

    const get = await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
    expect(get.body.status).toBe('succeeded');
    expect(await getOrder(h)).toMatchObject({ status: 'paid', paidAttemptId: attempt.attemptId });
    expect(countAuthorizations(h.db)).toBe(1);
  });

  test('tok_test_decline → 200 with declined/CARD_DECLINED (D-07)', async () => {
    const attempt = await createAttempt(h);
    const res = await authorize(h, attempt.attemptId, 'tok_test_decline').expect(200);
    expect(res.body).toMatchObject({ status: 'declined', failureCode: 'CARD_DECLINED' });
    expect((await getOrder(h)).status).toBe('open');
  });

  test('decline scenario on Affirm → AFFIRM_DECLINED', async () => {
    await h.api().post('/v1/mock/scenario').send({ nextOutcome: 'decline' }).expect(200);
    const attempt = await createAttempt(h, 'affirm');
    const res = await h.api().post(`/mock/affirm/checkout/${attempt.attemptId}/approve`).expect(302);
    expect(res.headers.location).toBe(`gametime-demo://payment/return?attemptId=${attempt.attemptId}&result=approved`);
    const get = await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
    expect(get.body).toMatchObject({ status: 'declined', failureCode: 'AFFIRM_DECLINED' });
  });

  test('scenario applies only to the next authorize', async () => {
    await h.api().post('/v1/mock/scenario').send({ nextOutcome: 'decline' }).expect(200);
    const a1 = await createAttempt(h);
    expect((await authorize(h, a1.attemptId).expect(200)).body.status).toBe('declined');
    const a2 = await createAttempt(h);
    expect((await authorize(h, a2.attemptId).expect(200)).body.status).toBe('succeeded');
  });

  test('cancel: awaiting_user → cancelled; terminal is idempotent; 404 when missing', async () => {
    const attempt = await createAttempt(h);
    const c1 = await h.api().post(`/v1/payment-attempts/${attempt.attemptId}/cancel`).expect(200);
    expect(c1.body.status).toBe('cancelled');
    const c2 = await h.api().post(`/v1/payment-attempts/${attempt.attemptId}/cancel`).expect(200);
    expect(c2.body.status).toBe('cancelled');
    await h.api().post(`/v1/payment-attempts/pat_${randomUUID()}/cancel`).expect(404);
    const auth = await authorize(h, attempt.attemptId).expect(409);
    expect(auth.body.error).toMatchObject({ code: 'ATTEMPT_NOT_AUTHORIZABLE', attempt: { status: 'cancelled' } });
  });

  test('a new create cancels the order\'s previous awaiting_user attempt', async () => {
    const a1 = await createAttempt(h);
    await createAttempt(h);
    const get = await h.api().get(`/v1/payment-attempts/${a1.attemptId}`).expect(200);
    expect(get.body.status).toBe('cancelled');
  });
});

describe('create validation', () => {
  test('missing header → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const body = createBody(await getOrder(h), 'card');
    const res = await h.api().post('/v1/payment-attempts').send(body).expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('invalid body → 422 VALIDATION_ERROR', async () => {
    const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', randomUUID()).send({ method: 'bitcoin' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('header different from clientAttemptId → 422', async () => {
    const body = createBody(await getOrder(h), 'card');
    await h.api().post('/v1/payment-attempts').set('Idempotency-Key', randomUUID()).send(body).expect(422);
  });

  test('malformed JSON → 422', async () => {
    await h
      .api()
      .post('/v1/payment-attempts')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json')
      .send('{bad')
      .expect(422);
  });

  test('badly formatted token → 422', async () => {
    const attempt = await createAttempt(h);
    await authorize(h, attempt.attemptId, '4242424242424242').expect(422);
  });

  test('authorize without header → 400; unknown attempt → 404', async () => {
    const attempt = await createAttempt(h);
    await h.api().post(`/v1/payment-attempts/${attempt.attemptId}/authorize`).send({ sourceToken: 'tok_test_visa_4242' }).expect(400);
    await authorize(h, `pat_${randomUUID()}`).expect(404);
    await h.api().get(`/v1/payment-attempts/pat_${randomUUID()}`).expect(404);
  });
});

describe('idempotency', () => {
  test('create: same key + same body → 200 replay with header; different body → 409', async () => {
    const body = createBody(await getOrder(h), 'card');
    const first = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(201);
    const replay = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.attemptId).toBe(first.body.attemptId);

    const other = { ...body, method: 'apple_pay' };
    const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(other).expect(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('create replay returns the CURRENT state (recovers attemptId after payment)', async () => {
    const body = createBody(await getOrder(h), 'card');
    const first = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(201);
    await authorize(h, first.body.attemptId).expect(200);
    const replay = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(200);
    expect(replay.body).toMatchObject({ attemptId: first.body.attemptId, status: 'succeeded' });
  });

  test('authorize: same key + same body → replay; different body → 409', async () => {
    const attempt = await createAttempt(h);
    const key = randomUUID();
    const first = await authorize(h, attempt.attemptId, 'tok_test_visa_4242', key).expect(200);
    const replay = await authorize(h, attempt.attemptId, 'tok_test_visa_4242', key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const mismatch = await authorize(h, attempt.attemptId, 'tok_test_mastercard_4444', key).expect(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(countAuthorizations(h.db)).toBe(1);
  });

  test('10 parallel authorizes with the SAME key → 1 authorization and identical responses', async () => {
    const attempt = await createAttempt(h);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 10 }, () => authorize(h, attempt.attemptId, 'tok_test_visa_4242', key)));
    expect(countAuthorizations(h.db)).toBe(1);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(responses[0].body.status).toBe('succeeded');
  });

  test('10 parallel authorizes with DIFFERENT keys → 1 authorization, the rest 409 ATTEMPT_NOT_AUTHORIZABLE', async () => {
    const attempt = await createAttempt(h);
    const responses = await Promise.all(Array.from({ length: 10 }, () => authorize(h, attempt.attemptId)));
    expect(countAuthorizations(h.db)).toBe(1);
    const okResponses = responses.filter(r => r.status === 200);
    const conflicts = responses.filter(r => r.status === 409);
    expect(okResponses).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const c of conflicts) {
      expect(c.body.error.code).toBe('ATTEMPT_NOT_AUTHORIZABLE');
      expect(c.body.error.attempt.status).toBe('succeeded');
    }
  });

  test('10 parallel authorizes with latency (interleaved requests) → 1 authorization', async () => {
    await h.api().post('/v1/mock/scenario').send({ latencyMs: 2000 }).expect(200);
    const attempt = await createAttempt(h);
    const key = randomUUID();
    const sameKey = await Promise.all(Array.from({ length: 5 }, () => authorize(h, attempt.attemptId, 'tok_test_visa_4242', key)));
    const otherKeys = await Promise.all(Array.from({ length: 5 }, () => authorize(h, attempt.attemptId)));
    expect(countAuthorizations(h.db)).toBe(1);
    expect(sameKey.every(r => r.status === 200)).toBe(true);
    expect(otherKeys.every(r => r.status === 409 && r.body.error.code === 'ATTEMPT_NOT_AUTHORIZABLE')).toBe(true);
    expect((await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`)).body.status).toBe('succeeded');
  });

  test('two attempts on the same order: the second gets ORDER_ALREADY_PAID or ATTEMPT_IN_PROGRESS', async () => {
    const a1 = await createAttempt(h);
    await authorize(h, a1.attemptId).expect(200);
    const body = createBody(await getOrder(h), 'card');
    const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(409);
    expect(['ORDER_ALREADY_PAID', 'ATTEMPT_IN_PROGRESS']).toContain(res.body.error.code);
    expect(countAuthorizations(h.db)).toBe(1);
  });

  test('unique index: the database rejects a 2nd succeeded on the same order', async () => {
    const a1 = await createAttempt(h);
    const a2 = await createAttempt(h);
    h.db.prepare(`UPDATE payment_attempts SET status = 'succeeded' WHERE id = ?`).run(a1.attemptId);
    expect(() => h.db.prepare(`UPDATE payment_attempts SET status = 'succeeded' WHERE id = ?`).run(a2.attemptId)).toThrow(/UNIQUE/);
  });

  test('UNIQUE(attempt_id) on authorizations', async () => {
    const attempt = await createAttempt(h);
    await authorize(h, attempt.attemptId).expect(200);
    expect(() =>
      h.db
        .prepare(`INSERT INTO authorizations (id, attempt_id, source_token_kind, outcome, created_at) VALUES ('x', ?, 'card_visa', 'approved', 'now')`)
        .run(attempt.attemptId),
    ).toThrow(/UNIQUE/);
  });
});

describe('processor scenarios', () => {
  test('drop_response: socket closes, GET shows succeeded, replay creates no 2nd authorization', async () => {
    const attempt = await createAttempt(h);
    await h.api().post('/v1/mock/scenario').send({ nextOutcome: 'drop_response' }).expect(200);
    const key = randomUUID();
    await expect(authorize(h, attempt.attemptId, 'tok_test_visa_4242', key)).rejects.toThrow(/socket hang up|ECONNRESET/);

    const get = await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
    expect(get.body.status).toBe('succeeded');

    const replay = await authorize(h, attempt.attemptId, 'tok_test_visa_4242', key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.status).toBe('succeeded');
    expect(countAuthorizations(h.db)).toBe(1);
  });

  test('processing: responds processing; after resolve_at, GET shows succeeded', async () => {
    const attempt = await createAttempt(h);
    await h.api().post('/v1/mock/scenario').send({ nextOutcome: 'processing' }).expect(200);
    const res = await authorize(h, attempt.attemptId).expect(200);
    expect(res.body.status).toBe('processing');

    h.clock.advance(4999);
    expect((await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`)).body.status).toBe('processing');
    // While processing: cannot cancel, and a new attempt is blocked.
    await h.api().post(`/v1/payment-attempts/${attempt.attemptId}/cancel`).expect(409);
    const body = createBody(await getOrder(h), 'card');
    const blocked = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'ATTEMPT_IN_PROGRESS', attempt: { attemptId: attempt.attemptId } });

    h.clock.advance(1);
    expect((await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`)).body.status).toBe('succeeded');
    expect((await getOrder(h)).status).toBe('paid');
  });

  test('latency: authorize waits and returns the final result', async () => {
    await h.api().post('/v1/mock/scenario').send({ latencyMs: 8000 }).expect(200);
    const attempt = await createAttempt(h);
    const before = h.clock.now().getTime();
    const res = await authorize(h, attempt.attemptId).expect(200);
    expect(res.body.status).toBe('succeeded');
    expect(h.clock.now().getTime() - before).toBe(8000);
  });
});

describe('QUOTE_STALE', () => {
  test('on create, after PUT /orders: 409 with the current quote', async () => {
    const stale = await getOrder(h);
    await h.api().put('/v1/orders/order_demo').send({ quantity: 1 }).expect(200);
    const body = createBody(stale, 'card');
    const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(409);
    expect(res.body.error).toMatchObject({ code: 'QUOTE_STALE', quote: { version: 2, total: { minorUnits: 5175 } } });
  });

  test('amount different from the current total → QUOTE_STALE', async () => {
    const quote = await getOrder(h);
    const body = { ...createBody(quote, 'card'), amount: { currency: 'USD', minorUnits: 1 } };
    const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(409);
    expect(res.body.error.code).toBe('QUOTE_STALE');
  });

  test('on authorize, after PUT /orders: 409 QUOTE_STALE and no authorization', async () => {
    const attempt = await createAttempt(h);
    await h.api().put('/v1/orders/order_demo').send({ quantity: 3 }).expect(200);
    const res = await authorize(h, attempt.attemptId).expect(409);
    expect(res.body.error).toMatchObject({ code: 'QUOTE_STALE', attempt: { status: 'cancelled', failureCode: 'QUOTE_STALE' } });
    expect(countAuthorizations(h.db)).toBe(0);
  });

  test('on authorize, version changed outside the PUT: marks cancelled QUOTE_STALE', async () => {
    const attempt = await createAttempt(h);
    h.db.prepare(`UPDATE orders SET version = version + 1`).run();
    const res = await authorize(h, attempt.attemptId).expect(409);
    expect(res.body.error.code).toBe('QUOTE_STALE');
    const get = await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
    expect(get.body).toMatchObject({ status: 'cancelled', failureCode: 'QUOTE_STALE' });
  });
});

describe('Affirm', () => {
  async function setTotal(minor: number | null) {
    return h.api().put('/v1/mock/orders/order_demo').send({ totalOverrideMinor: minor }).expect(200);
  }

  test('create with total 10000 → 422 METHOD_NOT_ELIGIBLE; 10001 → 201', async () => {
    await setTotal(10000);
    const q1 = await getOrder(h);
    const b1 = createBody(q1, 'affirm');
    const r1 = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', b1.clientAttemptId).send(b1).expect(422);
    expect(r1.body.error.code).toBe('METHOD_NOT_ELIGIBLE');

    await setTotal(10001);
    const q2 = await getOrder(h);
    expect(q2.total.minorUnits).toBe(10001);
    const b2 = createBody(q2, 'affirm');
    await h.api().post('/v1/payment-attempts').set('Idempotency-Key', b2.clientAttemptId).send(b2).expect(201);
  });

  test('override bumps the version; null returns to quantity-based pricing', async () => {
    const before = await getOrder(h);
    const r = await setTotal(9999);
    expect(r.body).toMatchObject({ version: before.version + 1, total: { minorUnits: 9999 } });
    const back = await setTotal(null);
    expect(back.body.total.minorUnits).toBe(10350);
  });

  test('page, approve → 302 to the scheme, GET succeeded', async () => {
    const attempt = await createAttempt(h, 'affirm');
    const page = await h.api().get(`/mock/affirm/checkout?attemptId=${attempt.attemptId}`).expect(200);
    expect(page.text).toContain('$103.50');
    expect(page.text).toContain(`/mock/affirm/checkout/${attempt.attemptId}/approve`);

    const res = await h.api().post(`/mock/affirm/checkout/${attempt.attemptId}/approve`).expect(302);
    expect(res.headers.location).toBe(`gametime-demo://payment/return?attemptId=${attempt.attemptId}&result=approved`);
    expect((await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`)).body.status).toBe('succeeded');
    expect(countAuthorizations(h.db)).toBe(1);

    // Double-clicking Approve creates no 2nd authorization.
    await h.api().post(`/mock/affirm/checkout/${attempt.attemptId}/approve`).expect(302);
    expect(countAuthorizations(h.db)).toBe(1);
  });

  test('cancel → 302 result=cancelled and attempt cancelled', async () => {
    const attempt = await createAttempt(h, 'affirm');
    const res = await h.api().post(`/mock/affirm/checkout/${attempt.attemptId}/cancel`).expect(302);
    expect(res.headers.location).toContain('result=cancelled');
    expect((await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`)).body.status).toBe('cancelled');
  });

  test('page rejects arbitrary attemptIds and attempts of other methods', async () => {
    await h.api().get('/mock/affirm/checkout?attemptId=<script>').expect(404);
    const card = await createAttempt(h, 'card');
    await h.api().get(`/mock/affirm/checkout?attemptId=${card.attemptId}`).expect(404);
    await h.api().post(`/mock/affirm/checkout/${card.attemptId}/approve`).expect(404);
  });
});

describe('mock and reset', () => {
  test('reset clears everything and recreates order_demo', async () => {
    const attempt = await createAttempt(h);
    await authorize(h, attempt.attemptId).expect(200);
    await h.api().post('/v1/mock/reset').expect(200);
    expect(await getOrder(h)).toMatchObject({ status: 'open', version: 1, quantity: 2 });
    expect(countAuthorizations(h.db)).toBe(0);
    await h.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(404);
  });

  test('mock routes return 404 without MOCK_MODE', async () => {
    const prod = await makeHarness({ mockMode: false });
    try {
      await prod.api().post('/v1/mock/scenario').send({ nextOutcome: 'decline' }).expect(404);
      await prod.api().post('/v1/mock/reset').expect(404);
      await prod.api().put('/v1/mock/orders/order_demo').send({ totalOverrideMinor: 15000 }).expect(404);
      await prod.api().get('/mock/affirm/checkout?attemptId=x').expect(404);
      await prod.api().get('/health').expect(200);
    } finally {
      await prod.close();
    }
  });
});

describe('persistence', () => {
  test('restart: closing and reopening the DB file returns the same attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gametime-'));
    const file = join(dir, 'restart.db');
    try {
      const first = await makeHarness({ file });
      const attempt = await createAttempt(first);
      await authorize(first, attempt.attemptId).expect(200);
      await first.close();

      const second = await makeHarness({ file });
      try {
        const res = await second.api().get(`/v1/payment-attempts/${attempt.attemptId}`).expect(200);
        expect(res.body).toMatchObject({ attemptId: attempt.attemptId, status: 'succeeded' });
        expect((await getOrder(second)).status).toBe('paid');
        expect(countAuthorizations(second.db)).toBe(1);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logs', () => {
  test('the log contains neither the raw token nor the body', async () => {
    const attempt = await createAttempt(h);
    const key = randomUUID();
    await authorize(h, attempt.attemptId, 'tok_test_visa_4242', key).expect(200);
    await authorize(h, attempt.attemptId, 'tok_test_decline').expect(409);
    await h.api().post(`/v1/payment-attempts/${attempt.attemptId}/authorize`).set('Idempotency-Key', randomUUID()).send({ sourceToken: '4242424242424242' });

    const all = h.logs.join('\n');
    expect(all).not.toContain('tok_test');
    expect(all).not.toContain('4242424242424242');
    expect(all).not.toContain('sourceToken');
    const authLine = h.logs.find(l => l.includes('/authorize') && l.includes(key.slice(0, 8)));
    expect(authLine).toBeDefined();
    expect(authLine).not.toContain(key); // only the 8-character prefix
    expect(JSON.parse(authLine!)).toMatchObject({ method: 'POST', status: 200, attemptId: attempt.attemptId });
  });

  test('ledger stores only the token kind', async () => {
    const attempt = await createAttempt(h);
    await authorize(h, attempt.attemptId, 'tok_test_amex_0005').expect(200);
    const row = h.db.prepare('SELECT source_token_kind FROM authorizations').get() as { source_token_kind: string };
    expect(row.source_token_kind).toBe('card_amex');
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM authorizations').all()) + JSON.stringify(h.db.prepare('SELECT * FROM idempotency_keys').all());
    expect(dump).not.toContain('tok_test');
  });
});

