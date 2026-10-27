import { TEST_TOKENS } from '@shared';
import { digitsOnly, last4, validateNumber, type CardForm } from '../domain/card';
import type { PaymentAdapter } from './types';

const ALWAYS_DECLINE_PAN = '4000000000000002';

/**
 * Fake tokenization: `tok_test_<brand>_<last4>`, or the decline token for the decline test card.
 * Only the token leaves the device, never the card number.
 */
export function tokenizeCard(form: CardForm): string {
  const digits = digitsOnly(form.number);
  if (digits === ALWAYS_DECLINE_PAN) {
    return TEST_TOKENS.decline;
  }
  return `tok_test_${validateNumber(digits).brand}_${last4(digits)}`;
}

export function createCardAdapter(): PaymentAdapter {
  return {
    method: 'card',
    async present(ctx) {
      return ctx.cardToken ? { kind: 'token', sourceToken: ctx.cardToken } : { kind: 'cancelled' };
    },
  };
}
