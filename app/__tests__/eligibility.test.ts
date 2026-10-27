import { formatUsd, type PaymentMethod } from '@shared';
import { eligibleMethods, type EligibilityInput } from '../src/domain/eligibility';

const usd = (minorUnits: number) => ({ currency: 'USD' as const, minorUnits });

const matrix: Array<[string, EligibilityInput, PaymentMethod[]]> = [
  ['ios + apple pay, 150', { platform: 'ios', applePayAvailable: true, googlePayReady: false, total: usd(15000) }, ['apple_pay', 'affirm', 'card']],
  ['ios without apple pay, 150', { platform: 'ios', applePayAvailable: false, googlePayReady: false, total: usd(15000) }, ['affirm', 'card']],
  ['ios ignores google pay', { platform: 'ios', applePayAvailable: true, googlePayReady: true, total: usd(5000) }, ['apple_pay', 'card']],
  ['android + google pay, 150', { platform: 'android', applePayAvailable: false, googlePayReady: true, total: usd(15000) }, ['google_pay', 'affirm', 'card']],
  ['android without google pay, 80', { platform: 'android', applePayAvailable: false, googlePayReady: false, total: usd(8000) }, ['card']],
  ['android ignores apple pay', { platform: 'android', applePayAvailable: true, googlePayReady: true, total: usd(8000) }, ['google_pay', 'card']],
];

describe('eligibleMethods', () => {
  test.each(matrix)('%s', (_name, input, expected) => {
    expect(eligibleMethods(input)).toEqual(expected);
  });

  describe.each(['ios', 'android'] as const)('Affirm threshold on %s', platform => {
    const base = { platform, applePayAvailable: false, googlePayReady: false };
    test('9999 → no affirm', () => {
      expect(eligibleMethods({ ...base, total: usd(9999) })).not.toContain('affirm');
    });
    test('10000 (exactly $100.00) → no affirm', () => {
      expect(eligibleMethods({ ...base, total: usd(10000) })).not.toContain('affirm');
    });
    test('10001 → affirm', () => {
      expect(eligibleMethods({ ...base, total: usd(10001) })).toContain('affirm');
    });
  });

  test('card always appears, last', () => {
    for (const [, input] of matrix) {
      const methods = eligibleMethods(input);
      expect(methods[methods.length - 1]).toBe('card');
    }
  });
});

describe('formatUsd', () => {
  test.each([
    [10350, '$103.50'],
    [5175, '$51.75'],
    [10000, '$100.00'],
    [9999, '$99.99'],
    [5, '$0.05'],
    [0, '$0.00'],
    [123456789, '$1,234,567.89'],
  ])('%i → %s', (minor, expected) => {
    expect(formatUsd(minor)).toBe(expected);
  });

  test('rejects non-integer values', () => {
    expect(() => formatUsd(10.5)).toThrow();
  });
});
