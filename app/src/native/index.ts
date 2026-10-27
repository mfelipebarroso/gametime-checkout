import NativeWalletCapability from './NativeWalletCapability';
import { createWalletCapability } from './walletCapability';

/** App-wide capability reader backed by the native Turbo Module. */
export const walletCapability = createWalletCapability(NativeWalletCapability);
