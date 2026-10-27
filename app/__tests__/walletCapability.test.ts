import { createWalletCapability, safeCheck } from '../src/native/walletCapability';

describe('walletCapability', () => {
  test('passes through real values', async () => {
    const cap = createWalletCapability({ isApplePayAvailable: async () => true, isGooglePayReady: async () => false });
    expect(await cap.getCapabilities()).toEqual({ applePayAvailable: true, googlePayReady: false });
  });

  test('missing native module → both false', async () => {
    expect(await createWalletCapability(null).getCapabilities()).toEqual({ applePayAvailable: false, googlePayReady: false });
    expect(await createWalletCapability(undefined).getCapabilities()).toEqual({ applePayAvailable: false, googlePayReady: false });
  });

  test('rejection, synchronous throw and non-boolean values → false', async () => {
    expect(await safeCheck(() => Promise.reject(new Error('boom')), 50)).toBe(false);
    expect(
      await safeCheck(() => {
        throw new Error('sync');
      }, 50),
    ).toBe(false);
    expect(await safeCheck(async () => 'yes' as unknown as boolean, 50)).toBe(false);
  });

  test('timeout → false (3 s by default)', async () => {
    jest.useFakeTimers();
    try {
      const pending = createWalletCapability({
        isApplePayAvailable: () => new Promise(() => undefined),
        isGooglePayReady: () => new Promise(() => undefined),
      }).getCapabilities();
      jest.advanceTimersByTime(2999);
      let settled = false;
      pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await pending).toEqual({ applePayAvailable: false, googlePayReady: false });
    } finally {
      jest.useRealTimers();
    }
  });
});
