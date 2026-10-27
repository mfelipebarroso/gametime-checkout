module.exports = {
  preset: '@react-native/jest-preset',
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/support/'],
  moduleNameMapper: {
    '^@shared$': '<rootDir>/../shared/index.ts',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
  },
};
