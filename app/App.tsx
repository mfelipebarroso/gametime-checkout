/**
 * Temporary screen (phases 0 and 4): confirms the @shared alias, gametime-demo:// deep links and
 * the real WalletCapability values. Replaced by CheckoutScreen in phase 5.
 *
 * @format
 */

import { useEffect, useState } from 'react';
import { Linking, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CONTRACT_VERSION } from '@shared';
import { consoleSink, createLogger } from './src/logger';
import { walletCapability } from './src/native';
import NativeWalletCapability from './src/native/NativeWalletCapability';
import type { Capabilities } from './src/native/walletCapability';

const logger = createLogger(consoleSink, { platform: Platform.OS });

function App() {
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  useEffect(() => {
    walletCapability.getCapabilities().then(caps => {
      setCapabilities(caps);
      logger.log('payment_method_eligible', { method: 'apple_pay', status: String(caps.applePayAvailable) });
      logger.log('payment_method_eligible', { method: 'google_pay', status: String(caps.googlePayReady) });
    });
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then(url => url && setLastUrl(url));
    const sub = Linking.addEventListener('url', ({ url }) => setLastUrl(url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <View style={styles.container}>
        <Text style={styles.title}>Gametime Checkout</Text>
        <Text>contract v{CONTRACT_VERSION}</Text>
        <Text testID="last-url">Last link: {lastUrl ?? '—'}</Text>
        <Text>Native module: {NativeWalletCapability ? 'present' : 'missing'}</Text>
        <Text testID="capabilities">
          Apple Pay: {capabilities ? String(capabilities.applePayAvailable) : '…'} · Google Pay:{' '}
          {capabilities ? String(capabilities.googlePayReady) : '…'}
        </Text>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
});

export default App;
