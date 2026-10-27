// Turbo Module spec for wallet capability detection (SPEC §2). Codegen reads this file.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  isApplePayAvailable(): Promise<boolean>;
  isGooglePayReady(): Promise<boolean>;
}

// `get` (not `getEnforcing`): a missing module means "no wallet", never a crash.
export default TurboModuleRegistry.get<Spec>('WalletCapability');
