import { DEFAULT_OVERRIDES, effectiveEnvironment } from '../src/dev/overrides';

const real = { applePayAvailable: true, googlePayReady: false };

describe('effectiveEnvironment', () => {
  test('defaults to real detection and the device platform', () => {
    expect(effectiveEnvironment('ios', real, DEFAULT_OVERRIDES)).toEqual({ platform: 'ios', applePayAvailable: true, googlePayReady: false });
  });

  test('overrides platform and capabilities independently', () => {
    expect(effectiveEnvironment('ios', real, { platform: 'android', applePay: 'unavailable', googlePay: 'ready' })).toEqual({
      platform: 'android',
      applePayAvailable: false,
      googlePayReady: true,
    });
  });

  test('"no provisioned cards" hides Apple Pay even when the device has cards', () => {
    expect(effectiveEnvironment('ios', real, { ...DEFAULT_OVERRIDES, applePay: 'unavailable' }).applePayAvailable).toBe(false);
  });
});
