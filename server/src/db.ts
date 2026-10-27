import Database from 'better-sqlite3';
import { DEMO_ORDER_ID } from '../../shared/index';

export type DB = Database.Database;

// Schema from SPEC §9.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, quantity INTEGER NOT NULL,
  unit_price_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL,
  total_override_minor INTEGER, status TEXT NOT NULL DEFAULT 'open',
  paid_attempt_id TEXT
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY, client_attempt_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id), order_version INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, failure_code TEXT, resolve_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_success_per_order ON payment_attempts(order_id) WHERE status = 'succeeded';
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('create','authorize')),
  request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_body TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  source_token_kind TEXT NOT NULL,
  outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

export const DEMO_ORDER = {
  id: DEMO_ORDER_ID,
  quantity: 2,
  unitPriceMinor: 4250,
  feeMinor: 925,
} as const;

export function openDb(filename: string): DB {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  seedDemoOrder(db);
  return db;
}

export function seedDemoOrder(db: DB): void {
  db.prepare(
    `INSERT OR IGNORE INTO orders (id, version, quantity, unit_price_minor, fee_minor, status)
     VALUES (?, 1, ?, ?, ?, 'open')`,
  ).run(DEMO_ORDER.id, DEMO_ORDER.quantity, DEMO_ORDER.unitPriceMinor, DEMO_ORDER.feeMinor);
}

/** Clears attempts, authorizations and keys, and recreates `order_demo` (POST /v1/mock/reset). */
export function resetDb(db: DB): void {
  db.transaction(() => {
    db.exec('DELETE FROM authorizations; DELETE FROM idempotency_keys; DELETE FROM payment_attempts; DELETE FROM orders;');
    seedDemoOrder(db);
  })();
}
