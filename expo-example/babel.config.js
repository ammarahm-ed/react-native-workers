// Babel config for the Expo example.
//
// `babel-preset-expo` replaces `@react-native/babel-preset` in Expo apps. The
// worker Babel plugin from this library is added on top: it scans
// `new Worker('./file')` calls, rewrites them to loadable refs, and records the
// per-worker bundling manifest — identical to the bare example's setup.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
  };
};
