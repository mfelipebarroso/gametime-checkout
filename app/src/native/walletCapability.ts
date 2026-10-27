// JS wrapper over the native WalletCapability module (SPEC §2). A failure, a throw or a 3 s timeout
// all mean `false`: that only hides the wallet button, it never blocks checkout.

export type Capabilities = { applePayAvailable: boolean; googlePayReady: boolean };

export interface WalletCapabilitySource {
  isApplePayAvailable(): Promise<boolean>;
  isGooglePayReady(): Promise<boolean>;
}

export const CAPABILITY_TIMEOUT_MS = 3000;

/** Stand-in when the native module is absent (tests, or a build without it): no wallet. */
export const unavailableWalletSource: WalletCapabilitySource = {
  isApplePayAvailable: async () => false,
  isGooglePayReady: async () => false,
};

export function safeCheck(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    let result: Promise<boolean>;
    try {
      result = check();
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    result.then(
      value => {
        clearTimeout(timer);
        resolve(value === true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export function createWalletCapability(source: WalletCapabilitySource | null | undefined, timeoutMs = CAPABILITY_TIMEOUT_MS) {
  const impl = source ?? unavailableWalletSource;
  return {
    async getCapabilities(): Promise<Capabilities> {
      const [applePayAvailable, googlePayReady] = await Promise.all([
        safeCheck(() => impl.isApplePayAvailable(), timeoutMs),
        safeCheck(() => impl.isGooglePayReady(), timeoutMs),
      ]);
      return { applePayAvailable, googlePayReady };
    },
  };
}
