// Environment simulator settings. Pure, so the effective eligibility input can be tested. Real detection
// stays the default.

import type { EligibilityInput, Platform } from '../domain/eligibility';
import type { Capabilities } from '../native/walletCapability';

export type PlatformOverride = 'device' | 'ios' | 'android';
export type ApplePayOverride = 'real' | 'available' | 'unavailable';
export type GooglePayOverride = 'real' | 'ready' | 'not_ready';

export type DevOverrides = {
  platform: PlatformOverride;
  applePay: ApplePayOverride;
  googlePay: GooglePayOverride;
};

export const DEFAULT_OVERRIDES: DevOverrides = { platform: 'device', applePay: 'real', googlePay: 'real' };

export type Environment = Omit<EligibilityInput, 'total'>;

export function effectiveEnvironment(devicePlatform: Platform, real: Capabilities, overrides: DevOverrides): Environment {
  return {
    platform: overrides.platform === 'device' ? devicePlatform : overrides.platform,
    applePayAvailable: overrides.applePay === 'real' ? real.applePayAvailable : overrides.applePay === 'available',
    googlePayReady: overrides.googlePay === 'real' ? real.googlePayReady : overrides.googlePay === 'ready',
  };
}
