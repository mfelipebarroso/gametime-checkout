// JS wrapper over the native WalletCapability module. A failure, a throw or a 3 s timeout
// all mean `false`: that only hides the wallet button, it never blocks checkout.

export type Capabilities = { applePayAvailable: boolean; googlePayReady: boolean };

interface WalletCapabilitySource {
  isApplePayAvailable(): Promise<boolean>;
  isGooglePayReady(): Promise<boolean>;
}

const CAPABILITY_TIMEOUT_MS = 3000;

/** Stand-in when the native module is absent (tests, or a build without it): no wallet. */
const unavailableWalletSource: WalletCapabilitySource = {
  isApplePayAvailable: async () => false,
  isGooglePayReady: async () => false,
};

/** Runs a capability check. Anything other than a timely `true` counts as `false`. */
export function safeCheck(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = Promise.resolve()
    .then(check)
    .then(
      value => value === true,
      () => false,
    );
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
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
