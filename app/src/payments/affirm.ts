import type { PaymentAdapter } from './types';

/**
 * Opens the mock Affirm checkout in the system browser. The outcome comes back through the
 * gametime-demo:// deep link or AppState, and the server always has the final word.
 */
export function createAffirmAdapter(openUrl: (url: string) => Promise<unknown>, checkoutUrl: (attemptId: string) => string): PaymentAdapter {
  return {
    method: 'affirm',
    async present(ctx) {
      await openUrl(checkoutUrl(ctx.attemptId));
      return { kind: 'redirected' };
    },
  };
}
