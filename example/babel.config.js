const path = require('path');
const { getConfig } = require('react-native-builder-bob/babel-config');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');

// Metro's babel preset only inlines `process.env.NODE_ENV`; any other env var
// survives into the bundle as an unresolved member expression and reads as
// `undefined` at runtime. Inline the ones we care about here rather than adding
// babel-plugin-transform-inline-environment-variables for a single string.
//
// The value is captured when METRO transforms the file, so changing it requires
// restarting Metro with `--reset-cache`.
const INLINED_ENV = ['RN_WORKERS_SCREEN'];

function inlineEnv({ types: t }) {
  return {
    name: 'rnworkers-inline-env',
    visitor: {
      MemberExpression(nodePath) {
        const { node } = nodePath;
        if (node.computed || node.property.type !== 'Identifier') return;
        if (!INLINED_ENV.includes(node.property.name)) return;
        // Match exactly `process.env.<NAME>`.
        const obj = node.object;
        if (
          obj.type !== 'MemberExpression' ||
          obj.computed ||
          obj.object.type !== 'Identifier' ||
          obj.object.name !== 'process' ||
          obj.property.type !== 'Identifier' ||
          obj.property.name !== 'env'
        ) {
          return;
        }
        const value = process.env[node.property.name];
        nodePath.replaceWith(
          value === undefined
            ? t.identifier('undefined')
            : t.stringLiteral(value)
        );
      },
    },
  };
}

module.exports = getConfig(
  {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      // Added by `nativescript-rn configure`. Rewrites callbacks carrying a
      // 'use ui' / 'use js' directive to NativeScript's thread invokers. The
      // NativeScript example does not need it — a UIWorker is already on the UI
      // thread — but it is the package's prescribed setup and is a no-op
      // otherwise.
      '@nativescript/react-native/babel-plugin',
      // Scans `new Worker('./file')` calls, rewrites them to loadable refs, and
      // records a manifest for release bundling.
      require.resolve('../plugin/index.js'),
      inlineEnv,
    ],
  },
  { root, pkg }
);
