// Client logger with a field allowlist and digit redaction (SPEC §10). Anything not on the
// allowlist is dropped, so form objects, request bodies and tokens can never reach the sink.

export type LogEvent =
  | 'checkout_viewed'
  | 'payment_method_eligible'
  | 'payment_attempt_created'
  | 'payment_create_rejected'
  | 'provider_presented'
  | 'provider_cancelled'
  | 'payment_authorization_started'
  | 'payment_authorization_unknown'
  | 'payment_reconciliation_started'
  | 'payment_succeeded'
  | 'payment_declined'
  | 'payment_duplicate_prevented'
  | 'quote_changed'
  | 'snapshot_corrupted'
  | 'deeplink_received'
  | 'deeplink_mismatch'
  | 'invalid_transition'
  | 'storage_error'
  | 'order_load_failed';

const ALLOWED_KEYS = [
  'method',
  'platform',
  'attemptId',
  'clientAttemptId',
  'status',
  'code',
  'phase',
  'durationMs',
  'orderVersion',
] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];
export type LogEntry = { event: LogEvent } & Partial<Record<AllowedKey, string | number | boolean>>;
export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  /** `attrs` is deliberately loose: unknown keys and non-primitive values are dropped at runtime. */
  log(event: LogEvent, attrs?: Record<string, unknown>): void;
}

const LONG_DIGITS = /\d{12,}/g;

export function redact(value: string): string {
  return value.replace(LONG_DIGITS, '[REDACTED]');
}

export function sanitize(event: LogEvent, attrs: Record<string, unknown> = {}): LogEntry {
  const entry: LogEntry = { event };
  for (const key of ALLOWED_KEYS) {
    const value = attrs[key];
    if (typeof value === 'string') {
      entry[key] = redact(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      entry[key] = value;
    }
  }
  return entry;
}

export function createLogger(sink: LogSink, base: Record<string, unknown> = {}): Logger {
  return {
    log(event, attrs) {
      sink(sanitize(event, { ...base, ...attrs }));
    },
  };
}

export const consoleSink: LogSink = entry => {
  // Entries are already sanitized; only a JSON string leaves this module.
  console.log(`[checkout] ${JSON.stringify(entry)}`);
};
