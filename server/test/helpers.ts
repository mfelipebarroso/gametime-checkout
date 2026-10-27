import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app';
import { FakeClock } from '../src/clock';
import { openDb, type DB } from '../src/db';
import type { Attempt, OrderQuote, PaymentMethod } from '../../shared/index';

export type Harness = {
  server: Server;
  db: DB;
  clock: FakeClock;
  logs: string[];
  api: () => request.Agent;
  close: () => Promise<void>;
};

export async function makeHarness(opts: { mockMode?: boolean; file?: string } = {}): Promise<Harness> {
  const db = openDb(opts.file ?? ':memory:');
  const clock = new FakeClock();
  const logs: string[] = [];
  const { app } = createApp({
    db,
    mockMode: opts.mockMode ?? true,
    clock,
    logSink: line => logs.push(line),
    sleep: async ms => clock.advance(ms), // instant latency: just advance the clock
  });
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    db,
    clock,
    logs,
    api: () => request.agent(server),
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

export async function getOrder(h: Harness): Promise<OrderQuote> {
  const res = await h.api().get('/v1/orders/order_demo').expect(200);
  return res.body as OrderQuote;
}

export function createBody(quote: OrderQuote, method: PaymentMethod, clientAttemptId = randomUUID()) {
  return {
    clientAttemptId,
    order: { id: quote.orderId, version: quote.version },
    amount: { currency: 'USD' as const, minorUnits: quote.total.minorUnits },
    method,
  };
}

export async function createAttempt(h: Harness, method: PaymentMethod = 'card'): Promise<Attempt> {
  const quote = await getOrder(h);
  const body = createBody(quote, method);
  const res = await h.api().post('/v1/payment-attempts').set('Idempotency-Key', body.clientAttemptId).send(body).expect(201);
  return res.body as Attempt;
}

export function authorize(h: Harness, attemptId: string, sourceToken = 'tok_test_visa_4242', key = randomUUID()) {
  return h.api().post(`/v1/payment-attempts/${attemptId}/authorize`).set('Idempotency-Key', key).send({ sourceToken });
}

export function countAuthorizations(db: DB, orderId = 'order_demo'): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM authorizations a JOIN payment_attempts p ON p.id = a.attempt_id WHERE p.order_id = ?')
    .get(orderId) as { n: number };
  return row.n;
}
