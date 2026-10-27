module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@shared$': '<rootDir>/../shared/index.ts',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
  },
};
