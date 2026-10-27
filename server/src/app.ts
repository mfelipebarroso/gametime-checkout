import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  MAX_QUANTITY,
  MIN_QUANTITY,
  PAYMENT_METHODS,
  returnUrl,
  type PaymentMethod,
} from '../../shared/index';
import { renderAffirmPage } from './affirmPage';
import { AttemptsService } from './attempts';
import { systemClock, type Clock } from './clock';
import { resetDb, type DB } from './db';
import { errors, fail, ok, type ServiceResult } from './http';
import { requestLogger, stdoutSink, type LogSink } from './logger';
import { MockProcessor } from './mockProcessor';
import { changeQuantity, getOrderRow, toQuote } from './orders';

type AppOptions = {
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
  method: z.enum(PAYMENT_METHODS as [PaymentMethod, ...PaymentMethod[]]),
});
const AuthorizeBody = z.object({ sourceToken: z.string().regex(/^tok_test_[a-z0-9_]{1,64}$/) });
const UpdateOrderBody = z.object({ quantity: z.number().int().min(MIN_QUANTITY).max(MAX_QUANTITY) });
const ScenarioBody = z.object({
  nextOutcome: z.enum(['approve', 'decline', 'processing', 'drop_response']).optional(),
  latencyMs: z.union([z.literal(0), z.literal(2000), z.literal(8000)]).optional(),
});
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
  send(res, errors.validation(`Invalid request: ${fields}`));
}

/** The drop_response scenario: the result is committed, but the app never hears back. */
function dropConnection(req: Request): void {
  req.socket.destroy();
}

function notFoundPage(res: Response): void {
  res.status(404).type('text/plain').send('Checkout not found');
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
    send(res, order ? ok(toQuote(order)) : errors.orderNotFound());
  });

  app.put('/v1/orders/:orderId', (req, res) => {
    const parsed = UpdateOrderBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    send(res, changeQuantity(db, req.params.orderId, parsed.data.quantity, clock.now()));
  });

  // ---------- Attempts ----------

  app.post('/v1/payment-attempts', (req, res) => {
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) return send(res, errors.keyRequired());
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    if (key !== parsed.data.clientAttemptId) {
      return send(res, errors.validation('Idempotency-Key must equal clientAttemptId'));
    }
    send(res, attempts.create(key, parsed.data));
  });

  app.post('/v1/payment-attempts/:attemptId/authorize', async (req, res) => {
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) return send(res, errors.keyRequired());
    if (!KeyHeader.safeParse(key).success) return send(res, errors.validation('Invalid Idempotency-Key'));
    const parsed = AuthorizeBody.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await attempts.authorizeSafe(req.params.attemptId, key, parsed.data.sourceToken);
    if (result.dropResponse) return dropConnection(req);
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
    app.post('/v1/mock/scenario', (req, res) => {
      const parsed = ScenarioBody.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      processor.setScenario(parsed.data);
      res.json(processor.getScenario());
    });

    app.post('/v1/mock/reset', (_req, res) => {
      resetDb(db);
      processor.reset();
      res.json({ ok: true });
    });

    app.get('/mock/affirm/checkout', (req, res) => {
      const attempt = attempts.findAffirmAttempt(typeof req.query.attemptId === 'string' ? req.query.attemptId : '');
      if (!attempt) return notFoundPage(res);
      res.type('html').send(renderAffirmPage(attempt));
    });

    // The redirect target is built on the server, never taken from the request (no open redirect).
    app.post('/mock/affirm/checkout/:attemptId/approve', async (req, res) => {
      const { attemptId } = req.params;
      if (!attempts.findAffirmAttempt(attemptId)) return notFoundPage(res);
      // Same path as a wallet authorize, with one fixed key per attempt.
      const result = await attempts.authorizeSafe(attemptId, `affirm:${attemptId}`, 'affirm');
      if (result.dropResponse) return dropConnection(req);
      res.redirect(302, returnUrl(attemptId, 'approved'));
    });

    app.post('/mock/affirm/checkout/:attemptId/cancel', (req, res) => {
      const { attemptId } = req.params;
      if (!attempts.findAffirmAttempt(attemptId)) return notFoundPage(res);
      attempts.cancel(attemptId);
      res.redirect(302, returnUrl(attemptId, 'cancelled'));
    });
  }

  // ---------- Fallbacks ----------

  app.use((_req, res) => {
    send(res, fail(404, 'NOT_FOUND', 'Not found'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
      return send(res, errors.validation('Malformed JSON body'));
    }
    send(res, fail(500, 'INTERNAL', 'Internal error'));
  });

  return { app, processor, attempts };
}
