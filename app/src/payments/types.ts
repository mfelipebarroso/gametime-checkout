import type { Money, PaymentMethod } from '@shared';

export type PresentResult = { kind: 'token'; sourceToken: string } | { kind: 'cancelled' } | { kind: 'redirected' };

export type PresentContext = {
  attemptId: string;
  amount: Money;
  /** Card only: the token produced from the validated form, held in memory. */
  cardToken?: string;
};

/** Each method's SDK sits behind this interface. Adapters never call the payment API. */
export interface PaymentAdapter {
  method: PaymentMethod;
  present(ctx: PresentContext): Promise<PresentResult>;
}
