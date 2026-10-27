/**
 * Phase 0: blank screen. Confirms the @shared alias and that gametime-demo:// deep links arrive.
 * Replaced by CheckoutScreen in phase 5.
 *
 * @format
 */

import { useEffect, useState } from 'react';
import { Linking, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CONTRACT_VERSION } from '@shared';

function App() {
  const [lastUrl, setLastUrl] = useState<string | null>(null);

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
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
});

export default App;
