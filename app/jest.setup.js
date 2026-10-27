// Native-backed modules have no implementation under Jest.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest'));
