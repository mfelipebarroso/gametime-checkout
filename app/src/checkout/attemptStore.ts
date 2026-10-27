// Persisted attempt snapshot. It holds identity and phase only: never the card number, CVC, expiry,
// source token or any form data.

import { PAYMENT_METHODS, type PaymentMethod } from '@shared';
import type { Logger } from '../logger';

export const SNAPSHOT_KEY = 'checkout.attempt.v1';

type SnapshotPhase = 'creating' | 'awaiting_user' | 'redirected' | 'authorizing';
const PHASES: readonly SnapshotPhase[] = ['creating', 'awaiting_user', 'redirected', 'authorizing'];

export type AttemptSnapshot = {
  v: 1;
  clientAttemptId: string;
  authorizeKey: string;
  attemptId: string | null;
  orderId: string;
  orderVersion: number;
  amountMinor: number;
  method: PaymentMethod;
  phase: SnapshotPhase;
  startedAt: string;
};

/** The subset of AsyncStorage the store needs, so tests can use an in-memory fake. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface AttemptStore {
  load(): Promise<AttemptSnapshot | null>;
  save(snapshot: AttemptSnapshot): Promise<void>;
  clear(): Promise<void>;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseSnapshot(raw: unknown): AttemptSnapshot | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const valid =
    r.v === 1 &&
    isString(r.clientAttemptId) &&
    isString(r.authorizeKey) &&
    (r.attemptId === null || isString(r.attemptId)) &&
    isString(r.orderId) &&
    isInt(r.orderVersion) &&
    isInt(r.amountMinor) &&
    PAYMENT_METHODS.includes(r.method as PaymentMethod) &&
    PHASES.includes(r.phase as SnapshotPhase) &&
    isString(r.startedAt);
  return valid ? pick(r as AttemptSnapshot) : null;
}

/** Copies only the known fields, so nothing else can ride along into storage. */
function pick(s: AttemptSnapshot): AttemptSnapshot {
  return {
    v: 1,
    clientAttemptId: s.clientAttemptId,
    authorizeKey: s.authorizeKey,
    attemptId: s.attemptId,
    orderId: s.orderId,
    orderVersion: s.orderVersion,
    amountMinor: s.amountMinor,
    method: s.method,
    phase: s.phase,
    startedAt: s.startedAt,
  };
}

export function createAttemptStore(storage: KeyValueStorage, logger: Logger): AttemptStore {
  return {
    async load() {
      const raw = await storage.getItem(SNAPSHOT_KEY);
      if (raw === null) {
        return null;
      }
      let snapshot: AttemptSnapshot | null = null;
      try {
        snapshot = parseSnapshot(JSON.parse(raw));
      } catch {
        snapshot = null;
      }
      if (!snapshot) {
        // No financial risk: the server prevents double payment and the order is reloaded on open.
        logger.log('snapshot_corrupted');
        await storage.removeItem(SNAPSHOT_KEY);
      }
      return snapshot;
    },
    async save(snapshot) {
      await storage.setItem(SNAPSHOT_KEY, JSON.stringify(pick(snapshot)));
    },
    async clear() {
      await storage.removeItem(SNAPSHOT_KEY);
    },
  };
}
