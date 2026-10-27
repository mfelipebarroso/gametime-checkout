import { ApiError, createHttpClient, createPaymentApi, isUncertain } from '../src/api/paymentApi';
import { baseUrlFor } from '../src/api/config';

type FetchArgs = [string, RequestInit];

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function fakeFetch(handler: (...args: FetchArgs) => Promise<Response>) {
  return jest.fn(handler) as unknown as jest.Mock<Promise<Response>, FetchArgs> & typeof fetch;
}

const TIMEOUTS = { default: 50, create: 50, authorize: 80 };

describe('paymentApi', () => {
  test('create sends the clientAttemptId as Idempotency-Key and JSON body', async () => {
    const f = fakeFetch(async () => jsonResponse(201, { attemptId: 'pat_1' }));
    const api = createPaymentApi('http://h', TIMEOUTS, createHttpClient('http://h', f));
    const body = { clientAttemptId: 'c1', order: { id: 'order_demo', version: 1 }, amount: { currency: 'USD' as const, minorUnits: 10350 }, method: 'card' as const };
    await api.createAttempt(body);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://h/v1/payment-attempts');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('c1');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test('authorize uses the authorize key, not the client attempt id', async () => {
    const f = fakeFetch(async () => jsonResponse(200, { status: 'succeeded' }));
    const api = createPaymentApi('http://h', TIMEOUTS, createHttpClient('http://h', f));
    await api.authorize('pat_1', 'auth-key', 'tok_test_visa_4242');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://h/v1/payment-attempts/pat_1/authorize');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('auth-key');
  });

  test('HTTP errors are normalized with code, attempt and quote, without the body in the message', async () => {
    const attempt = { attemptId: 'pat_1', status: 'succeeded' };
    const f = fakeFetch(async () => jsonResponse(409, { error: { code: 'ATTEMPT_NOT_AUTHORIZABLE', message: 'x', attempt } }));
    const http = createHttpClient('http://h', f);
    const err = (await http('/x', { method: 'POST', body: { sourceToken: 'tok_test_visa_4242' }, timeoutMs: 50 }).catch(e => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'http', status: 409, code: 'ATTEMPT_NOT_AUTHORIZABLE', attempt });
    expect(err.message).toBe('http_409_ATTEMPT_NOT_AUTHORIZABLE');
    expect(err.message).not.toContain('tok_test');
    expect(isUncertain(err)).toBe(false);
  });

  test('5xx and non-JSON bodies are uncertain', async () => {
    const f = fakeFetch(async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) as unknown as Response);
    const err = await createHttpClient('http://h', f)('/x', { method: 'GET', timeoutMs: 50 }).catch(e => e);
    expect(err).toMatchObject({ kind: 'http', status: 502 });
    expect(isUncertain(err)).toBe(true);
  });

  test('network failure → kind network', async () => {
    const f = fakeFetch(async () => {
      throw new TypeError('Network request failed');
    });
    const err = await createHttpClient('http://h', f)('/x', { method: 'GET', timeoutMs: 50 }).catch(e => e);
    expect(err).toMatchObject({ kind: 'network' });
    expect(isUncertain(err)).toBe(true);
  });

  test('timeout aborts the request → kind timeout', async () => {
    const f = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const err = await createHttpClient('http://h', f)('/x', { method: 'GET', timeoutMs: 20 }).catch(e => e);
    expect(err).toMatchObject({ kind: 'timeout' });
  });

  test('base URL per platform', () => {
    expect(baseUrlFor('ios')).toBe('http://localhost:4000');
    expect(baseUrlFor('android')).toBe('http://10.0.2.2:4000');
  });
});
