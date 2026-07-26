// Metro config for the standalone Expo example.
//
// This example is intentionally NOT a workspace of the library repo: it installs
// `@ammarahmed/react-native-workers` as a packed tarball into its own
// node_modules, exactly like a real Expo app. That means `react-native` resolves
// to THIS app's copy (one version), so no monorepo watch folders, source-export
// condition, or single-React resolver hacks are needed — just Expo's defaults
// plus `withWorkers` to keep worker bundles small.
const { getDefaultConfig } = require('expo/metro-config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

module.exports = withWorkers(getDefaultConfig(__dirname));
