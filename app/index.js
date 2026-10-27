/**
 * @format
 */

// Must load before anything that imports `uuid` (crypto.getRandomValues polyfill).
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
