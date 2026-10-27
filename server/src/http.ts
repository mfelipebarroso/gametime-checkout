import type { ApiErrorBody, ApiErrorCode, Attempt, OrderQuote } from '../../shared/index';

/** A service result: the handler only serializes it. Business errors don't throw, so the transaction can commit. */
export type ServiceResult = {
  status: number;
  body: unknown;
  replayed?: boolean;
};

export function ok(body: unknown, status = 200): ServiceResult {
  return { status, body };
}

export function fail(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: { attempt?: Attempt; quote?: OrderQuote } = {},
): ServiceResult {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return { status, body };
}
