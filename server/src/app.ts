import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  MAX_QUANTITY,
  MIN_QUANTITY,
  PAYMENT_METHODS,
  RETURN_URL_BASE,
  type Attempt,
} from '../../shared/index';
import { renderAffirmPage } from './affirmPage';
import { AttemptsService } from './attempts';
import { systemClock, type Clock } from './clock';
import { resetDb, type DB } from './db';
import { fail, ok, type ServiceResult } from './http';
import { requestLogger, stdoutSink, type LogSink } from './logger';
import { MockProcessor } from './mockProcessor';
import { bumpVersion, getOrderRow, toQuote } from './orders';

export type AppOptions = {
  db: DB;
  mockMode: boolean;
  clock?: Clock;
  logSink?: LogSink;
  sleep?: (ms: number) => Promise<void>;
};

const CreateBody = z.object({
  clientAttemptId: z.uuid(),
  order: z.object({ id: z.string().min(1).max(100), version: z.number().int().positive() }),
  amount: z.object({ currency: z.literal('USD'), minorUnits: z.number().int().positive() }),
  method: z.enum(PAYMENT_METHODS as [string, ...string[]]).transform(m => m as Attempt['method']),
});
const AuthorizeBody = z.object({ sourceToken: z.string().regex(/^tok_test_[a-z0-9_]{1,64}$/) });
const UpdateOrderBody = z.object({ quantity: z.number().int().min(MIN_QUANTITY).max(MAX_QUANTITY) });
const ScenarioBody = z.object({
  nextOutcome: z.enum(['approve', 'decline', 'processing', 'drop_response']).optional(),
  latencyMs: z.union([z.literal(0), z.literal(2000), z.literal(8000)]).optional(),
});
const MockOrderBody = z.object({
  totalOverrideMinor: z.union([z.literal(9999), z.literal(10000), z.literal(10001), z.literal(15000), z.null()]),
});
const AttemptIdParam = /^pat_[0-9a-f-]{36}$/;
const KeyHeader = z.string().min(8).max(200);

function send(res: Response, result: ServiceResult): void {
  if (result.replayed) {
    res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  }
  res.status(result.status).json(result.body);
}

function validationError(res: Response, error: z.ZodError): void {
  // Field paths only: never echo values (they may contain a token).
  const fields = [...new Set(error.issues.map(i => i.path.join('.') || '(body)'))].join(', ');
  send(res, fail(422, 'VALIDATION_ERROR', `Invalid request: ${fields}`));
}

function returnUrl(attemptId: string, result: 'approved' | 'cancelled'): string {
  // Fixed on the server: never taken from the query string (prevents an open redirect).
  return `${RETURN_URL_BASE}?attemptId=${encodeURIComponent(attemptId)}&result=${result}`;
}

export function createApp(options: AppOptions) {
  const { db, mockMode } = options;
  const clock = options.clock ?? systemClock;
  const processor = new MockProcessor();
  const attempts = new AttemptsService({
    db,
    clock,
    processor,
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  });

  const app = express();
  app.disable('x-powered-by');
  // Payment state must never come from an HTTP cache: no ETags (no 304s), no caching of API responses.
  app.set('etag', false);
  app.use('/v1', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(requestLogger(options.logSink ?? stdoutSink));
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ---------- Order ----------

  app.get('/v1/orders/:orderId', (req, res) => {
    const order = getOrderRow(db, req.params.orderId);
    send(res, order ? ok(toQuote(order)) : fail(404, 'ORDER_NOT_FOUND', 'Order not found'));
  });

  app.put('/v1/orders/:orderId', (req, res) => {
    const parsed = UpdateOrderBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = db.transaction((): ServiceResult => {
      const order = getOrderRow(db, req.params.orderId);
      if (!order) return fail(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status === 'paid') return fail(409, 'ORDER_ALREADY_PAID', 'This order has already been paid');
      // Changing the quantity returns to "Quantity" mode (drops the dev menu override).
      bumpVersion(db, order.id, { quantity: parsed.data.quantity, totalOverrideMinor: null }, clock.now());
      return ok(toQuote(getOrderRow(db, order.id)!));
    })();
    send(res, result);
  });

  // ---------- Attempts ----------

  app.post('/v1/payment-attempts', (req, res) => {
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) return send(res, fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'));
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    if (key !== parsed.data.clientAttemptId) {
      return send(res, fail(422, 'VALIDATION_ERROR', 'Idempotency-Key must equal clientAttemptId'));
    }
    send(res, attempts.create(key, parsed.data));
  });

  app.post('/v1/payment-attempts/:attemptId/authorize', async (req, res) => {
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) return send(res, fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'));
    if (!KeyHeader.safeParse(key).success) return send(res, fail(422, 'VALIDATION_ERROR', 'Invalid Idempotency-Key'));
    const parsed = AuthorizeBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await attempts.authorizeSafe(req.params.attemptId, key, parsed.data.sourceToken);
    if (result.dropResponse) {
      // Result already committed: simulates "the server charged, the app never knew".
      req.socket.destroy();
      return;
    }
    send(res, result);
  });

  app.post('/v1/payment-attempts/:attemptId/cancel', (req, res) => {
    send(res, attempts.cancel(req.params.attemptId));
  });

  app.get('/v1/payment-attempts/:attemptId', (req, res) => {
    send(res, attempts.get(req.params.attemptId));
  });

  // ---------- Mock (MOCK_MODE=1 only) ----------

  if (mockMode) {
    app.get('/v1/mock/scenario', (_req, res) => {
      res.json(processor.getScenario());
    });

    app.post('/v1/mock/scenario', (req, res) => {
      const parsed = ScenarioBody.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      processor.setScenario(parsed.data);
      res.json(processor.getScenario());
    });

    app.put('/v1/mock/orders/:orderId', (req, res) => {
      const parsed = MockOrderBody.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const result = db.transaction((): ServiceResult => {
        const order = getOrderRow(db, req.params.orderId);
        if (!order) return fail(404, 'ORDER_NOT_FOUND', 'Order not found');
        if (order.status === 'paid') return fail(409, 'ORDER_ALREADY_PAID', 'This order has already been paid');
        bumpVersion(db, order.id, { totalOverrideMinor: parsed.data.totalOverrideMinor }, clock.now());
        return ok(toQuote(getOrderRow(db, order.id)!));
      })();
      send(res, result);
    });

    app.post('/v1/mock/reset', (_req, res) => {
      resetDb(db);
      processor.reset();
      res.json({ ok: true });
    });

    app.get('/mock/affirm/checkout', (req, res) => {
      const attemptId = typeof req.query.attemptId === 'string' ? req.query.attemptId : '';
      const result = AttemptIdParam.test(attemptId) ? attempts.get(attemptId) : null;
      if (!result || result.status !== 200 || (result.body as Attempt).method !== 'affirm') {
        res.status(404).type('text/plain').send('Checkout not found');
        return;
      }
      res.type('html').send(renderAffirmPage(result.body as Attempt));
    });

    app.post('/mock/affirm/checkout/:attemptId/:action', async (req, res) => {
      const { attemptId, action } = req.params;
      const current = AttemptIdParam.test(attemptId) ? attempts.get(attemptId) : null;
      if (!current || current.status !== 200 || (current.body as Attempt).method !== 'affirm') {
        res.status(404).type('text/plain').send('Checkout not found');
        return;
      }
      if (action === 'approve') {
        // Same path as authorize, with a fixed key per attempt.
        const result = await attempts.authorizeSafe(attemptId, `affirm:${attemptId}`, 'affirm');
        if (result.dropResponse) {
          req.socket.destroy();
          return;
        }
        res.redirect(302, returnUrl(attemptId, 'approved'));
        return;
      }
      if (action === 'cancel') {
        attempts.cancel(attemptId);
        res.redirect(302, returnUrl(attemptId, 'cancelled'));
        return;
      }
      res.status(404).type('text/plain').send('Not found');
    });
  }

  // ---------- Fallbacks ----------

  app.use((_req, res) => {
    send(res, fail(404, 'NOT_FOUND', 'Not found'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
      return send(res, fail(422, 'VALIDATION_ERROR', 'Malformed JSON body'));
    }
    send(res, fail(500, 'INTERNAL', 'Internal error'));
  });

  return { app, processor, attempts };
}
