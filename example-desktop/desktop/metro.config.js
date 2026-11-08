const path = require('path');
const { makeMetroConfig } = require('@react-native-gpui/core/metro.config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

const library = path.resolve(__dirname, '..', '..');
const config = makeMetroConfig({ projectRoot: path.resolve(__dirname, '..') });

// The shared conformance suites live in the library's own example, and the
// library itself is read from its TypeScript sources.
config.watchFolders = [...(config.watchFolders ?? []), library];
config.resolver.unstable_conditionNames = [
  ...(config.resolver.unstable_conditionNames ?? []),
  'ammarahmed-react-native-workers-source',
];

module.exports = withWorkers(config);
