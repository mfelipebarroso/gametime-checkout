import type { PaymentAdapter } from './types';

/**
 * Affirm (D-10): opens the mock checkout page in the system browser. The outcome comes back through
 * the gametime-demo:// deep link or AppState, and is always confirmed by the server.
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
