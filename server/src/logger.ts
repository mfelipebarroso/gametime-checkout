// One line per request: method, path, status, duration, attemptId and the first 8 characters of the
// idempotency key. Never bodies or query strings.

import type { NextFunction, Request, Response } from 'express';
import { IDEMPOTENCY_KEY_HEADER, redact } from '../../shared/index';

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = line => process.stdout.write(`${line}\n`);

export function requestLogger(sink: LogSink) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => logLine(sink, req, res.statusCode, Date.now() - started));
    res.on('close', () => {
      // Socket destroyed before a response (the drop_response scenario).
      if (!res.writableFinished) {
        logLine(sink, req, 0, Date.now() - started);
      }
    });
    next();
  };
}

function logLine(sink: LogSink, req: Request, status: number, durationMs: number): void {
  const key = req.header(IDEMPOTENCY_KEY_HEADER);
  const fromPath: unknown = req.params?.attemptId;
  const fromQuery: unknown = req.query.attemptId;
  const attemptId = typeof fromPath === 'string' ? fromPath : typeof fromQuery === 'string' ? fromQuery : undefined;
  const entry: Record<string, string | number> = { method: req.method, path: req.path, status, durationMs };
  if (attemptId) entry.attemptId = attemptId;
  if (key) entry.idemKeyPrefix = key.slice(0, 8);
  sink(redact(JSON.stringify(entry)));
}
