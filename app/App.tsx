/**
 * @format
 */

import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CheckoutScreen } from './src/ui/CheckoutScreen';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <CheckoutScreen />
    </SafeAreaProvider>
  );
}

export default App;
