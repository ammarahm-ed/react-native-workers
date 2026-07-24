'use strict';

/**
 * Minimal worker shim for `react-native`.
 *
 * Only what a worker needs to reach native modules: `Platform`,
 * `NativeModules`, `TurboModuleRegistry`, the event emitters and `Systrace`.
 * ~61 KB of Hermes bytecode per worker versus ~147 KB for the standard shim,
 * because `Blob`/`XMLHttpRequest` and their dependencies stay out of the graph.
 *
 * Opt in with `withWorkers(config, { shim: 'minimal' })`. Anything left out
 * still resolves — it throws on access with a message saying which tier it
 * lives in, rather than silently being `undefined`.
 */

const core = require('./core');

const exported = Object.create(null);
for (const key of Object.keys(core)) {
  if (key.indexOf('__rnworkers') === 0) continue;
  Object.defineProperty(
    exported,
    key,
    Object.getOwnPropertyDescriptor(core, key)
  );
}

module.exports = core.__rnworkersSealTier(exported);
