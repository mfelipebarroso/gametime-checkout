import type { OrderQuote } from '../../shared/index';
import type { DB } from './db';

export type OrderRow = {
  id: string;
  version: number;
  quantity: number;
  unit_price_minor: number;
  fee_minor: number;
  total_override_minor: number | null;
  status: 'open' | 'paid';
  paid_attempt_id: string | null;
};

const EVENT_NAME = 'Bay City Comets vs. Harbor Kings';
const SEAT_INFO = 'Section 112 · Row F';

const usd = (minorUnits: number) => ({ currency: 'USD' as const, minorUnits });

export function getOrderRow(db: DB, id: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
}

/** With a dev menu override, the total is the forced value (shown as subtotal, no fees). */
export function toQuote(row: OrderRow): OrderQuote {
  const override = row.total_override_minor;
  const subtotal = override ?? row.quantity * row.unit_price_minor;
  const fees = override !== null ? 0 : row.quantity * row.fee_minor;
  return {
    orderId: row.id,
    version: row.version,
    eventName: EVENT_NAME,
    seatInfo: SEAT_INFO,
    quantity: row.quantity,
    unitPrice: usd(row.unit_price_minor),
    feePerTicket: usd(row.fee_minor),
    subtotal: usd(subtotal),
    fees: usd(fees),
    total: usd(subtotal + fees),
    status: row.status,
    ...(row.paid_attempt_id ? { paidAttemptId: row.paid_attempt_id } : {}),
  };
}

/** A version change cancels the order's `awaiting_user` attempts (SPEC §5.2), marking them QUOTE_STALE. */
export function bumpVersion(db: DB, id: string, changes: { quantity?: number; totalOverrideMinor: number | null }, now: Date): void {
  db.prepare(
    `UPDATE orders SET version = version + 1, quantity = COALESCE(?, quantity), total_override_minor = ? WHERE id = ?`,
  ).run(changes.quantity ?? null, changes.totalOverrideMinor, id);
  db.prepare(
    `UPDATE payment_attempts SET status = 'cancelled', failure_code = 'QUOTE_STALE', updated_at = ?
     WHERE order_id = ? AND status = 'awaiting_user'`,
  ).run(now.toISOString(), id);
}
