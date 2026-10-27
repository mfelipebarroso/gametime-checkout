import {
  IDEMPOTENCY_KEY_HEADER,
  type ApiErrorBody,
  type ApiErrorCode,
  type Attempt,
  type AuthorizeRequest,
  type CreateAttemptRequest,
  type OrderQuote,
  type UpdateOrderRequest,
} from '@shared';

type ApiErrorKind = 'network' | 'timeout' | 'http';

/** Normalized API error. The message never includes request or response bodies. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: ApiErrorCode;
  readonly attempt?: Attempt;
  readonly quote?: OrderQuote;

  constructor(init: { kind: ApiErrorKind; status?: number; code?: ApiErrorCode; attempt?: Attempt; quote?: OrderQuote }) {
    super(init.kind === 'http' ? `http_${init.status}_${init.code ?? 'unknown'}` : init.kind);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.attempt = init.attempt;
    this.quote = init.quote;
  }
}

/** Timeouts, network failures and 5xx: the request may or may not have taken effect. */
export function isUncertain(err: unknown): boolean {
  if (!(err instanceof ApiError)) {
    return true;
  }
  return err.kind !== 'http' || (err.status ?? 0) >= 500;
}

export function isHttpError(err: unknown, code: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && err.kind === 'http' && err.code === code;
}

export interface PaymentApi {
  getOrder(orderId: string): Promise<OrderQuote>;
  updateQuantity(orderId: string, quantity: number): Promise<OrderQuote>;
  /** The Idempotency-Key is the body's `clientAttemptId`. */
  createAttempt(body: CreateAttemptRequest): Promise<Attempt>;
  authorize(attemptId: string, authorizeKey: string, sourceToken: string): Promise<Attempt>;
  cancelAttempt(attemptId: string): Promise<Attempt>;
  getAttempt(attemptId: string): Promise<Attempt>;
  affirmCheckoutUrl(attemptId: string): string;
}

type FetchLike = typeof fetch;

type RequestOptions = {
  method: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs: number;
};

type HttpClient = <T>(path: string, options: RequestOptions) => Promise<T>;

export function createHttpClient(baseUrl: string, fetchImpl: FetchLike = fetch): HttpClient {
  return async function request<T>(path: string, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotencyKey) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError({ kind: timedOut ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      throw new ApiError({
        kind: 'http',
        status: response.status,
        code: error?.code,
        attempt: error?.attempt,
        quote: error?.quote,
      });
    }
    return payload as T;
  };
}

export type Timeouts = { default: number; create: number; authorize: number };

export function createPaymentApi(baseUrl: string, timeouts: Timeouts, http: HttpClient = createHttpClient(baseUrl)): PaymentApi {
  const enc = encodeURIComponent;
  return {
    getOrder: orderId => http(`/v1/orders/${enc(orderId)}`, { method: 'GET', timeoutMs: timeouts.default }),
    updateQuantity: (orderId, quantity) =>
      http(`/v1/orders/${enc(orderId)}`, { method: 'PUT', body: { quantity } satisfies UpdateOrderRequest, timeoutMs: timeouts.default }),
    createAttempt: body =>
      http('/v1/payment-attempts', {
        method: 'POST',
        body,
        idempotencyKey: body.clientAttemptId,
        timeoutMs: timeouts.create,
      }),
    authorize: (attemptId, authorizeKey, sourceToken) =>
      http(`/v1/payment-attempts/${enc(attemptId)}/authorize`, {
        method: 'POST',
        body: { sourceToken } satisfies AuthorizeRequest,
        idempotencyKey: authorizeKey,
        timeoutMs: timeouts.authorize,
      }),
    cancelAttempt: attemptId =>
      http(`/v1/payment-attempts/${enc(attemptId)}/cancel`, { method: 'POST', timeoutMs: timeouts.default }),
    getAttempt: attemptId => http(`/v1/payment-attempts/${enc(attemptId)}`, { method: 'GET', timeoutMs: timeouts.default }),
    affirmCheckoutUrl: attemptId => `${baseUrl}/mock/affirm/checkout?attemptId=${enc(attemptId)}`,
  };
}
