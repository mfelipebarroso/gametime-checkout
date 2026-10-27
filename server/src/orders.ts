import type { OrderQuote } from '../../shared/index';
import type { DB } from './db';
import { errors, ok, type ServiceResult } from './http';

type OrderRow = {
  id: string;
  version: number;
  quantity: number;
  unit_price_minor: number;
  fee_minor: number;
  status: 'open' | 'paid';
  paid_attempt_id: string | null;
};

const EVENT_NAME = 'Bay City Comets vs. Harbor Kings';
const SEAT_INFO = 'Section 112 · Row F';

const usd = (minorUnits: number) => ({ currency: 'USD' as const, minorUnits });

export function getOrderRow(db: DB, id: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
}

export function toQuote(row: OrderRow): OrderQuote {
  const subtotal = row.quantity * row.unit_price_minor;
  const fees = row.quantity * row.fee_minor;
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

/**
 * Sets the quantity and bumps the version. The order's `awaiting_user` attempts were priced on the old
 * version, so they are cancelled as QUOTE_STALE.
 */
export function changeQuantity(db: DB, id: string, quantity: number, now: Date): ServiceResult {
  return db.transaction((): ServiceResult => {
    const order = getOrderRow(db, id);
    if (!order) return errors.orderNotFound();
    if (order.status === 'paid') return errors.orderAlreadyPaid();

    db.prepare('UPDATE orders SET version = version + 1, quantity = ? WHERE id = ?').run(quantity, id);
    db.prepare(
      `UPDATE payment_attempts SET status = 'cancelled', failure_code = 'QUOTE_STALE', updated_at = ?
       WHERE order_id = ? AND status = 'awaiting_user'`,
    ).run(now.toISOString(), id);
    return ok(toQuote(getOrderRow(db, id)!));
  })();
}
