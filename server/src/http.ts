import type { ApiErrorBody, ApiErrorCode, Attempt, OrderQuote } from '../../shared/index';

/**
 * What a service returns and a route serializes. Business errors are values, not exceptions, so a
 * transaction can still commit the work it did before deciding to fail.
 */
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

export const errors = {
  orderNotFound: () => fail(404, 'ORDER_NOT_FOUND', 'Order not found'),
  orderAlreadyPaid: () => fail(409, 'ORDER_ALREADY_PAID', 'This order has already been paid'),
  attemptNotFound: () => fail(404, 'ATTEMPT_NOT_FOUND', 'Payment attempt not found'),
  keyRequired: () => fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'),
  keyReused: () => fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request'),
  quoteStale: (extra: { quote: OrderQuote; attempt?: Attempt }) => fail(409, 'QUOTE_STALE', 'The order total changed', extra),
  notAuthorizable: (attempt?: Attempt) =>
    fail(409, 'ATTEMPT_NOT_AUTHORIZABLE', 'This payment attempt can no longer be authorized', attempt ? { attempt } : {}),
  validation: (message: string) => fail(422, 'VALIDATION_ERROR', message),
};
