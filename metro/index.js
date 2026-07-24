'use strict';

/**
 * Metro configuration for react-native-workers.
 *
 * Wrap your app's config:
 *
 *   const { withWorkers } = require('@ammarahmed/react-native-workers/metro');
 *   module.exports = withWorkers(getDefaultConfig(__dirname));
 *
 * The only thing this changes is how `react-native` resolves inside *worker*
 * graphs — the app's own bundle is untouched. Without it, every worker that
 * reaches a native module embeds the entire framework (the renderer, the
 * component library, Animated, virtualized-lists): ~1.4 MB of Hermes bytecode
 * per worker, none of which a runtime with no view tree can use. With it, the
 * same worker is ~150 KB.
 *
 * Worker graphs are identified by the custom resolver option `rnworkers`, set
 * by the dev-server URL (`resolveWorkerSource.ts`) and by the release CLI
 * (`cli/index.js`), so a worker bundles the same way in dev and release.
 */

const path = require('path');

/** The custom resolver option that marks a graph as a worker graph. */
const WORKER_RESOLVER_OPTION = 'rnworkers';

const SHIMS = {
  standard: path.join(__dirname, '..', 'worker-shim', 'react-native.js'),
  minimal: path.join(__dirname, '..', 'worker-shim', 'react-native.minimal.js'),
};

function isReactNativeBarrel(moduleName) {
  return (
    moduleName === 'react-native' ||
    moduleName === 'react-native/index' ||
    moduleName === 'react-native/index.js'
  );
}

/**
 * @param {object} config The app's Metro config.
 * @param {{shim?: 'standard'|'minimal'|false}} [options]
 *   `'standard'` (default) also provides `Blob`, `FormData`, `XMLHttpRequest`,
 *   `AppState` and `Linking`. `'minimal'` drops those for ~86 KB less bytecode
 *   per worker. `false` disables the shim, so workers embed the whole framework
 *   as they would without this plugin — an escape hatch for a dependency that
 *   needs an export the shim cannot provide.
 */
function withWorkers(config, options = {}) {
  const { shim = 'standard' } = options;
  if (shim === false) return config;

  const shimPath = SHIMS[shim];
  if (!shimPath) {
    throw new Error(
      `[react-native-workers] withWorkers(): unknown shim ${JSON.stringify(shim)}. ` +
        `Expected 'standard', 'minimal' or false.`
    );
  }

  const resolver = config.resolver || {};
  const previous = resolver.resolveRequest;

  return {
    ...config,
    resolver: {
      ...resolver,
      resolveRequest(context, moduleName, platform) {
        const custom = context.customResolverOptions;
        if (
          custom &&
          custom[WORKER_RESOLVER_OPTION] &&
          isReactNativeBarrel(moduleName)
        ) {
          return { type: 'sourceFile', filePath: shimPath };
        }
        return previous
          ? previous(context, moduleName, platform)
          : context.resolveRequest(context, moduleName, platform);
      },
    },
  };
}

module.exports = { withWorkers, WORKER_RESOLVER_OPTION };
