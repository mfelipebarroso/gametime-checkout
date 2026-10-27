module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        alias: { '@shared': '../shared' },
        extensions: ['.ts', '.tsx', '.js', '.json'],
      },
    ],
  ],
};
