const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMetroConfig } = require('react-native-monorepo-config');
const { withWorkers } = require('../metro');

const root = path.resolve(__dirname, '..');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = withMetroConfig(getDefaultConfig(__dirname), {
  root,
  dirname: __dirname,
  conditions: ['ammarahmed-react-native-workers-source'],
});

/**
 * `@nativescript/react-native` ships its interop installer and its React host
 * component in one entry point. Workers want the installer and can never use the
 * component, but importing it drags RN's renderer into the worker graph. Swap it
 * for a stub in worker graphs only — the app's own bundle is untouched.
 *
 * Keyed off the same `rnworkers` custom resolver option `withWorkers()` uses, so
 * dev and release bundles agree.
 */
function withNativeScriptWorkerShim(cfg) {
  const stub = path.join(__dirname, 'metro-shims', 'nativescript-uiview.js');
  const resolver = cfg.resolver || {};
  const previous = resolver.resolveRequest;
  return {
    ...cfg,
    resolver: {
      ...resolver,
      resolveRequest(context, moduleName, platform) {
        if (
          context.customResolverOptions?.rnworkers &&
          moduleName.endsWith('NativeScriptUIViewNativeComponent')
        ) {
          return { type: 'sourceFile', filePath: stub };
        }
        return previous
          ? previous(context, moduleName, platform)
          : context.resolveRequest(context, moduleName, platform);
      },
    },
  };
}

module.exports = withNativeScriptWorkerShim(withWorkers(config));
