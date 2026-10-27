module.exports = {
  preset: '@react-native/jest-preset',
  // ESM-only packages that Jest must transform.
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage|uuid)/)'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/support/'],
  moduleNameMapper: {
    '^@shared$': '<rootDir>/../shared/index.ts',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
  },
};
