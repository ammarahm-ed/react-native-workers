'use strict';

/* eslint-disable @react-native/no-deep-imports -- deep imports ARE the point: this shim exists so worker bundles reach RN internals without pulling in the barrel. */

/**
 * Standard worker shim for `react-native` — the default.
 *
 * Adds the data types and networking primitives on top of `core.js`. These are
 * worker-legal but cost real bytes (~86 KB of Hermes bytecode), because pulling
 * in `Blob` and `XMLHttpRequest` drags RN's blob registry and networking stack
 * along with them. Apps that never touch them can drop to `react-native.minimal`
 * via `withWorkers(config, { shim: 'minimal' })`.
 *
 * Measured on the example app's `gzip` worker (Hermes bytecode, minified):
 *
 *   full `react-native` barrel   1.39 MB   499 modules
 *   standard shim (this file)     147 KB    80 modules
 *   minimal shim                   61 KB    42 modules
 *
 * See `core.js` for the rules on what may be added here — chiefly that every
 * `require` below lands in every worker bundle, lazy getter or not.
 */

const core = require('./core');

const interop = core.__rnworkersInterop;
const real = core.__rnworkersReal;

// Start from the core surface, preserving its lazy getters.
const exported = Object.create(null);
for (const key of Object.keys(core)) {
  if (key.indexOf('__rnworkers') === 0) continue;
  Object.defineProperty(
    exported,
    key,
    Object.getOwnPropertyDescriptor(core, key)
  );
}

// Data types. RN installs most of these as globals on the host, but a worker
// bundle that imports them by name still needs the name to resolve.
real(exported, 'Blob', () =>
  interop(require('react-native/Libraries/Blob/Blob'))
);
real(exported, 'File', () =>
  interop(require('react-native/Libraries/Blob/File'))
);
real(exported, 'FileReader', () =>
  interop(require('react-native/Libraries/Blob/FileReader'))
);
real(exported, 'URL', () => require('react-native/Libraries/Blob/URL').URL);
real(
  exported,
  'URLSearchParams',
  () => require('react-native/Libraries/Blob/URL').URLSearchParams
);
real(exported, 'FormData', () =>
  interop(require('react-native/Libraries/Network/FormData'))
);
real(exported, 'XMLHttpRequest', () =>
  interop(require('react-native/Libraries/Network/XMLHttpRequest'))
);

// Non-UI native APIs a worker can legitimately drive.
real(exported, 'AppState', () =>
  interop(require('react-native/Libraries/AppState/AppState'))
);
real(exported, 'Linking', () =>
  interop(require('react-native/Libraries/Linking/Linking'))
);

module.exports = core.__rnworkersSealTier(exported);
