// Composition root: wires the real API, storage, adapters and logger into an orchestrator.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEMO_ORDER_ID, type OrderQuote, type PaymentMethod } from '@shared';
import { Linking } from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import { API_BASE_URL, TIMEOUTS_MS } from '../api/config';
import { createPaymentApi } from '../api/paymentApi';
import type { Logger } from '../logger';
import { createAffirmAdapter } from '../payments/affirm';
import { createCardAdapter } from '../payments/card';
import { createWalletSheetAdapter, type WalletSheetController } from '../payments/walletSheet';
import { createAttemptStore } from './attemptStore';
import { CheckoutOrchestrator } from './orchestrator';

export function createCheckout(deps: {
  logger: Logger;
  sheets: WalletSheetController;
  isEligible: (method: PaymentMethod, quote: OrderQuote) => boolean;
}): CheckoutOrchestrator {
  const api = createPaymentApi(API_BASE_URL, TIMEOUTS_MS);
  return new CheckoutOrchestrator({
    api,
    store: createAttemptStore(AsyncStorage, deps.logger),
    adapters: {
      apple_pay: createWalletSheetAdapter('apple_pay', deps.sheets),
      google_pay: createWalletSheetAdapter('google_pay', deps.sheets),
      affirm: createAffirmAdapter(url => Linking.openURL(url), id => api.affirmCheckoutUrl(id)),
      card: createCardAdapter(),
    },
    logger: deps.logger,
    orderId: DEMO_ORDER_ID,
    newId: () => uuidv4(),
    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    isEligible: deps.isEligible,
  });
}
