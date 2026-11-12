module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Rewrites `new Worker('./file')` to a loadable reference and records the
  // entry for the release bundler.
  plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
};
