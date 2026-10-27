import { RETURN_URL_BASE } from '@shared';

/** Parses `gametime-demo://payment/return?attemptId=…&result=…` by hand (RN's URL support is partial). */
export function parseReturnUrl(url: string): { attemptId: string | null; result: string | null } | null {
  if (url !== RETURN_URL_BASE && !url.startsWith(`${RETURN_URL_BASE}?`)) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const pair of url.slice(RETURN_URL_BASE.length + 1).split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  }
  return { attemptId: params.attemptId ?? null, result: params.result ?? null };
}
