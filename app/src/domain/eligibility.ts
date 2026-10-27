import { AFFIRM_MIN_EXCLUSIVE_MINOR, type Money, type PaymentMethod } from '@shared';

export type Platform = 'ios' | 'android';

export type EligibilityInput = {
  platform: Platform;
  applePayAvailable: boolean;
  googlePayReady: boolean;
  total: Money;
};

/** Affirm only when the total is strictly greater than $100.00 (invariant 7). */
export function isAffirmEligible(total: Money): boolean {
  return total.currency === 'USD' && total.minorUnits > AFFIRM_MIN_EXCLUSIVE_MINOR;
}

/** Display order: platform wallet, Affirm, card. Card always appears (invariant 8). */
export function eligibleMethods(input: EligibilityInput): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  if (input.platform === 'ios' && input.applePayAvailable) {
    methods.push('apple_pay');
  }
  if (input.platform === 'android' && input.googlePayReady) {
    methods.push('google_pay');
  }
  if (isAffirmEligible(input.total)) {
    methods.push('affirm');
  }
  methods.push('card');
  return methods;
}
