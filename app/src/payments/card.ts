import { digitsOnly, validateNumber, type CardForm } from '../domain/card';
import type { PaymentAdapter } from './types';

/** Test card that the mock processor always declines (SPEC §3). */
const ALWAYS_DECLINE_PAN = '4000000000000002';

/**
 * Fake tokenization: `tok_test_<brand>_<last4>`, or `tok_test_decline` for the decline test card.
 * Only this token leaves the device; the card number never does.
 */
export function tokenizeCard(form: CardForm): string {
  const digits = digitsOnly(form.number);
  if (digits === ALWAYS_DECLINE_PAN) {
    return 'tok_test_decline';
  }
  const { brand } = validateNumber(digits);
  return `tok_test_${brand}_${digits.slice(-4)}`;
}

export function createCardAdapter(): PaymentAdapter {
  return {
    method: 'card',
    async present(ctx) {
      return ctx.cardToken ? { kind: 'token', sourceToken: ctx.cardToken } : { kind: 'cancelled' };
    },
  };
}
