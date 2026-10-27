const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const sharedDir = path.resolve(__dirname, '../shared');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * `shared/` lives outside app/; watchFolders lets Metro resolve and watch those files.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [sharedDir],
  resolver: {
    extraNodeModules: { '@shared': sharedDir },
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
