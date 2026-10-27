import { createHash } from 'node:crypto';
import type { DB } from './db';

export type Scope = 'create' | 'authorize';

/** Canonical JSON: keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

type KeyRow = { request_hash: string; response_status: number; response_body: string };

export type KeyLookup =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' };

export function lookupKey(db: DB, scope: Scope, key: string, hash: string): KeyLookup {
  const row = db
    .prepare('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = ? AND key = ?')
    .get(scope, key) as KeyRow | undefined;
  if (!row) {
    return { kind: 'new' };
  }
  if (row.request_hash !== hash) {
    return { kind: 'mismatch' };
  }
  return { kind: 'replay', status: row.response_status, body: JSON.parse(row.response_body) };
}

export function storeKey(db: DB, scope: Scope, key: string, hash: string, status: number, body: unknown, now: Date): void {
  db.prepare(
    `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(key, scope, hash, status, JSON.stringify(body), now.toISOString());
}

export function updateStoredResponse(db: DB, scope: Scope, key: string, status: number, body: unknown): void {
  db.prepare('UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE scope = ? AND key = ?').run(
    status,
    JSON.stringify(body),
    scope,
    key,
  );
}
