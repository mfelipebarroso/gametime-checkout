// Payment attempts. Every mutation runs inside db.transaction(). better-sqlite3 is synchronous, so
// transactions never interleave, and the UNIQUE constraints are the last line of defense against a
// double charge.

import { randomUUID } from 'node:crypto';
import {
  AFFIRM_MIN_EXCLUSIVE_MINOR,
  type Attempt,
  type AttemptStatus,
  type CreateAttemptRequest,
  type FailureCode,
  type PaymentMethod,
} from '../../shared/index';
import type { Clock } from './clock';
import type { DB } from './db';
import { errors, fail, ok, type ServiceResult } from './http';
import { lookupKey, requestHash, storeKey, updateStoredResponse } from './idempotency';
import { declineCode, sourceTokenKind, type MockProcessor } from './mockProcessor';
import { getOrderRow, toQuote } from './orders';

type AttemptRow = {
  id: string;
  client_attempt_id: string;
  order_id: string;
  order_version: number;
  amount_minor: number;
  currency: 'USD';
  method: PaymentMethod;
  status: AttemptStatus;
  failure_code: FailureCode | null;
  resolve_at: string | null;
  created_at: string;
  updated_at: string;
};

type AuthorizationRow = { outcome: 'approved' | 'declined' };

/** `dropResponse` tells the route to destroy the socket after the commit. */
export type AuthorizeResult = ServiceResult & { dropResponse?: boolean };

export type AttemptsDeps = {
  db: DB;
  clock: Clock;
  processor: MockProcessor;
  sleep: (ms: number) => Promise<void>;
};

export function toAttempt(row: AttemptRow): Attempt {
  return {
    attemptId: row.id,
    clientAttemptId: row.client_attempt_id,
    orderId: row.order_id,
    orderVersion: row.order_version,
    amount: { currency: row.currency, minorUnits: row.amount_minor },
    method: row.method,
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ATTEMPT_ID_RE = /^pat_[0-9a-f-]{36}$/;

function getRow(db: DB, id: string): AttemptRow | undefined {
  return db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT');
}

export class AttemptsService {
  constructor(private readonly deps: AttemptsDeps) {}

  private get db(): DB {
    return this.deps.db;
  }

  private nowIso(): string {
    return this.deps.clock.now().toISOString();
  }

  // ---------- Get ----------

  get(attemptId: string): ServiceResult {
    const attempt = this.db.transaction(() => {
      this.resolveIfDue(attemptId);
      return getRow(this.db, attemptId);
    })();
    return attempt ? ok(toAttempt(attempt)) : errors.attemptNotFound();
  }

  /** Lazily resolves an expired `processing`. Must run inside a transaction. */
  private resolveIfDue(attemptId: string): void {
    const row = getRow(this.db, attemptId);
    if (!row || row.status !== 'processing' || !row.resolve_at) {
      return;
    }
    if (new Date(row.resolve_at).getTime() > this.deps.clock.now().getTime()) {
      return;
    }
    const auth = this.db.prepare('SELECT outcome FROM authorizations WHERE attempt_id = ?').get(attemptId) as
      | AuthorizationRow
      | undefined;
    this.applyOutcome(row, auth?.outcome ?? 'approved');
  }

  /** Records the final result. If approved, marks the order paid (the unique index prevents paying twice). */
  private applyOutcome(row: AttemptRow, outcome: 'approved' | 'declined'): void {
    const now = this.nowIso();
    if (outcome === 'approved') {
      this.db
        .prepare(`UPDATE payment_attempts SET status = 'succeeded', resolve_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now, row.id);
      this.db.prepare(`UPDATE orders SET status = 'paid', paid_attempt_id = ? WHERE id = ?`).run(row.id, row.order_id);
    } else {
      this.db
        .prepare(`UPDATE payment_attempts SET status = 'declined', failure_code = ?, resolve_at = NULL, updated_at = ? WHERE id = ?`)
        .run(declineCode(row.method), now, row.id);
    }
  }

  // ---------- Create ----------

  create(key: string, body: CreateAttemptRequest): ServiceResult {
    const hash = requestHash(body);
    return this.db.transaction((): ServiceResult => {
      const prior = lookupKey(this.db, 'create', key, hash);
      if (prior.kind === 'mismatch') {
        return errors.keyReused();
      }
      if (prior.kind === 'replay') {
        // Return the attempt's current state (this is how the client recovers attemptId after losing the response).
        const attemptId = (prior.body as Attempt).attemptId;
        this.resolveIfDue(attemptId);
        const row = getRow(this.db, attemptId);
        return { status: 200, body: row ? toAttempt(row) : prior.body, replayed: true };
      }

      const order = getOrderRow(this.db, body.order.id);
      if (!order) {
        return errors.orderNotFound();
      }
      if (order.status === 'paid') {
        return errors.orderAlreadyPaid();
      }
      const quote = toQuote(order);
      if (body.order.version !== order.version || body.amount.minorUnits !== quote.total.minorUnits) {
        return errors.quoteStale({ quote });
      }
      const inProgress = this.db
        .prepare(`SELECT * FROM payment_attempts WHERE order_id = ? AND status = 'processing' LIMIT 1`)
        .get(order.id) as AttemptRow | undefined;
      if (inProgress) {
        return fail(409, 'ATTEMPT_IN_PROGRESS', 'Another payment is in progress', { attempt: toAttempt(inProgress) });
      }
      if (body.method === 'affirm' && quote.total.minorUnits <= AFFIRM_MIN_EXCLUSIVE_MINOR) {
        return fail(422, 'METHOD_NOT_ELIGIBLE', 'Affirm is available for orders over $100.00');
      }

      const now = this.nowIso();
      // No `awaiting_user` attempt has been authorized, so cancelling is safe.
      this.db
        .prepare(`UPDATE payment_attempts SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status = 'awaiting_user'`)
        .run(now, order.id);

      const id = `pat_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO payment_attempts (id, client_attempt_id, order_id, order_version, amount_minor, currency, method, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'USD', ?, 'awaiting_user', ?, ?)`,
        )
        .run(id, body.clientAttemptId, order.id, order.version, body.amount.minorUnits, body.method, now, now);
      const attempt = toAttempt(getRow(this.db, id)!);
      storeKey(this.db, 'create', key, hash, 201, attempt, this.deps.clock.now());
      return ok(attempt, 201);
    })();
  }

  // ---------- Authorize ----------

  /**
   * With latency, the attempt is `processing` (with a resolve_at) while the request waits. A GET in the
   * meantime sees `processing`, so killing the app never leaves the attempt in an ambiguous state.
   */
  async authorize(attemptId: string, key: string, sourceToken: string): Promise<AuthorizeResult> {
    const hash = requestHash({ attemptId, sourceToken });
    let pendingUntilMs = 0;
    let dropResponse = false;

    const result = this.db.transaction((): ServiceResult => {
      const prior = lookupKey(this.db, 'authorize', key, hash);
      if (prior.kind === 'mismatch') {
        return errors.keyReused();
      }
      if (prior.kind === 'replay') {
        return { status: prior.status, body: prior.body, replayed: true };
      }

      const row = getRow(this.db, attemptId);
      if (!row) {
        return errors.attemptNotFound();
      }
      const order = getOrderRow(this.db, row.order_id)!;
      if (row.status === 'cancelled' && row.failure_code === 'QUOTE_STALE') {
        return errors.quoteStale({ attempt: toAttempt(row), quote: toQuote(order) });
      }
      if (row.status !== 'awaiting_user') {
        return errors.notAuthorizable(toAttempt(row));
      }

      // The order changed after the attempt was created: never charge the old price.
      if (order.version !== row.order_version) {
        this.db
          .prepare(`UPDATE payment_attempts SET status = 'cancelled', failure_code = 'QUOTE_STALE', updated_at = ? WHERE id = ?`)
          .run(this.nowIso(), row.id);
        return errors.quoteStale({ attempt: toAttempt(getRow(this.db, row.id)!), quote: toQuote(order) });
      }
      if (order.status === 'paid') {
        return errors.orderAlreadyPaid();
      }

      // UNIQUE(attempt_id): one authorization per attempt.
      const decision = this.deps.processor.decide(sourceToken);
      const now = this.deps.clock.now();
      this.db
        .prepare(`INSERT INTO authorizations (id, attempt_id, source_token_kind, outcome, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(`auth_${randomUUID()}`, row.id, sourceTokenKind(sourceToken), decision.outcome, now.toISOString());

      if (decision.holdMs > 0) {
        const resolveAt = new Date(now.getTime() + decision.holdMs).toISOString();
        this.db
          .prepare(`UPDATE payment_attempts SET status = 'processing', resolve_at = ?, updated_at = ? WHERE id = ?`)
          .run(resolveAt, now.toISOString(), row.id);
        if (!decision.respondWhileProcessing) {
          pendingUntilMs = decision.holdMs;
        }
      } else {
        this.applyOutcome(row, decision.outcome);
      }
      dropResponse = decision.dropResponse;

      const attempt = toAttempt(getRow(this.db, row.id)!);
      storeKey(this.db, 'authorize', key, hash, 200, attempt, now);
      return ok(attempt);
    })();

    if (pendingUntilMs > 0) {
      await this.deps.sleep(pendingUntilMs);
      const final = this.db.transaction(() => {
        this.resolveIfDue(attemptId);
        const attempt = toAttempt(getRow(this.db, attemptId)!);
        updateStoredResponse(this.db, 'authorize', key, 200, attempt);
        return attempt;
      })();
      return { ...ok(final), dropResponse };
    }
    return { ...result, dropResponse };
  }

  /** authorize(), with a UNIQUE violation (the last line of defense) turned into a 409. */
  async authorizeSafe(attemptId: string, key: string, sourceToken: string): Promise<AuthorizeResult> {
    try {
      return await this.authorize(attemptId, key, sourceToken);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = getRow(this.db, attemptId);
        return errors.notAuthorizable(row && toAttempt(row));
      }
      throw err;
    }
  }

  // ---------- Cancel ----------

  cancel(attemptId: string): ServiceResult {
    return this.db.transaction((): ServiceResult => {
      this.resolveIfDue(attemptId);
      const row = getRow(this.db, attemptId);
      if (!row) {
        return errors.attemptNotFound();
      }
      if (row.status === 'processing') {
        return fail(409, 'ATTEMPT_NOT_CANCELLABLE', 'This payment is being processed', { attempt: toAttempt(row) });
      }
      if (row.status === 'awaiting_user') {
        this.db
          .prepare(`UPDATE payment_attempts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'awaiting_user'`)
          .run(this.nowIso(), row.id);
      }
      return ok(toAttempt(getRow(this.db, attemptId)!));
    })();
  }

  /** The attempt behind the mock Affirm page, or null when the id is unknown or not an Affirm attempt. */
  findAffirmAttempt(attemptId: string): Attempt | null {
    if (!ATTEMPT_ID_RE.test(attemptId)) {
      return null;
    }
    const result = this.get(attemptId);
    const attempt = result.status === 200 ? (result.body as Attempt) : null;
    return attempt?.method === 'affirm' ? attempt : null;
  }
}
