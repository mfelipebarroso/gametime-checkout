// Request log without body (SPEC §10): method, route, status, attemptId and idempotency key prefix.

import type { NextFunction, Request, Response } from 'express';

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = line => process.stdout.write(`${line}\n`);

const LONG_DIGITS = /\d{12,}/g;

/** Any run of 12+ digits becomes [REDACTED], as a safety net. */
export function redact(value: string): string {
  return value.replace(LONG_DIGITS, '[REDACTED]');
}

export function requestLogger(sink: LogSink) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => logLine(sink, req, res.statusCode, Date.now() - started));
    res.on('close', () => {
      if (!res.writableFinished) {
        logLine(sink, req, 0, Date.now() - started); // socket destroyed (drop_response)
      }
    });
    next();
  };
}

function logLine(sink: LogSink, req: Request, status: number, durationMs: number): void {
  const key = req.header('Idempotency-Key');
  const attemptId = (req.params?.attemptId as string | undefined) ?? (typeof req.query.attemptId === 'string' ? req.query.attemptId : undefined);
  const entry: Record<string, string | number> = {
    method: req.method,
    path: req.path, // no query string
    status,
    durationMs,
  };
  if (attemptId) entry.attemptId = attemptId;
  if (key) entry.idemKeyPrefix = key.slice(0, 8);
  sink(redact(JSON.stringify(entry)));
}
