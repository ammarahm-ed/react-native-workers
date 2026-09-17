'use strict';

const path = require('path');

/**
 * Where the worker journal lives — the one place that knows.
 *
 * It is build state, not source: the Babel plugin (`plugin/index.js`) appends to
 * it as Metro transforms the app for the main bundle, and the `rn-workers-bundle`
 * CLI (`cli/index.js`) reads and compacts it back into the worker entry list.
 * Both sides resolve it through here so they cannot drift apart.
 *
 * It sits under the project's `node_modules/.cache`, the conventional home for
 * build caches (babel-loader, eslint, prettier, webpack), rather than at
 * `<projectRoot>/.rn-workers`. That keeps a tool's scratch file out of every
 * consuming app's root — and `node_modules` is gitignored in every project
 * already, so no app has to add an ignore rule for us.
 */
const CACHE_SEGMENTS = ['node_modules', '.cache', 'react-native-workers'];

/**
 * Built from `projectRoot` rather than resolved through Node's module lookup:
 * in a hoisted monorepo the package (and therefore any directory inside it)
 * is shared by every app in the workspace, which would leave them all writing
 * into one journal. This way each app gets its own.
 *
 * Nothing creates it up front — the writer mkdirs on demand. A read-only
 * `node_modules`, or Yarn PnP which has none, leaves the journal empty; the CLI
 * logs that and falls back to its source scan, so the build still works.
 */
function journalDir(projectRoot) {
  return path.join(projectRoot, ...CACHE_SEGMENTS);
}

function journalPath(projectRoot) {
  return path.join(journalDir(projectRoot), 'manifest.log');
}

module.exports = { journalDir, journalPath };
