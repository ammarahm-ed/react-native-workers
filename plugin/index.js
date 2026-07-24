'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = '@ammarahmed/react-native-workers';
const RESOLVE_EXTS = [
  '',
  '.native.ts',
  '.native.tsx',
  '.native.js',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

function resolveEntry(spec, fromFile) {
  const baseDir = path.dirname(fromFile);
  const abs = path.resolve(baseDir, spec);
  for (const ext of RESOLVE_EXTS) {
    const candidate = abs + ext;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_e) {
      // keep trying
    }
  }
  // Fall back to the literal path + .js (may not exist yet in watch mode).
  return path.extname(abs) ? abs : abs + '.js';
}

function toEntryId(absPath, projectRoot) {
  let rel = path.relative(projectRoot, absPath);
  rel = rel.split(path.sep).join('/');
  return rel.replace(/\.(native\.)?(t|j)sx?$/, '').replace(/\.(mjs|cjs)$/, '');
}

// Append a manifest entry via a journal (Metro transforms run in parallel
// worker processes; a journal + compaction avoids read-modify-write races).
function recordEntry(projectRoot, id, absPath, fromFile) {
  try {
    const dir = path.join(projectRoot, '.rn-workers');
    fs.mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({ id, absPath, requestedFrom: fromFile }) + '\n';
    fs.appendFileSync(path.join(dir, 'manifest.log'), line);
  } catch (_e) {
    // Non-fatal: dev mode does not need the manifest (Metro serves any entry).
  }
}

function stringFromNode(node) {
  if (node && node.type === 'StringLiteral') return node.value;
  return null;
}

// Extract the specifier from `new URL('./x.js', import.meta.url)`.
function specFromUrlExpression(node) {
  if (
    node &&
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'URL' &&
    node.arguments.length >= 1
  ) {
    return stringFromNode(node.arguments[0]);
  }
  return null;
}

// Every exported constructor that takes a worker source as its first argument.
// UIWorker is a Worker subclass with the same signature, so a source specifier
// must be rewritten for it identically — missing it here leaves the raw string
// in place and the worker fetches a path that does not exist.
const WORKER_EXPORTS = new Set(['Worker', 'UIWorker']);

module.exports = function reactNativeWorkersPlugin(babel) {
  const { types: t } = babel;

  return {
    name: 'react-native-workers',
    // Parse `import.meta` so form C doesn't choke Metro (which lacks support).
    manipulateOptions(_opts, parserOpts) {
      if (!parserOpts.plugins.includes('importMeta')) {
        parserOpts.plugins.push('importMeta');
      }
    },
    pre() {
      this.workerLocals = new Set();
      this.matchGlobal = !!(this.opts && this.opts.matchGlobalWorker);
      this.helperId = null; // cached __workerRef local identifier for this file
    },
    visitor: {
      ImportDeclaration(pathNode) {
        if (pathNode.node.source.value !== PACKAGE_NAME) return;
        for (const spec of pathNode.node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            WORKER_EXPORTS.has(spec.imported.name)
          ) {
            this.workerLocals.add(spec.local.name);
          }
        }
      },
      NewExpression(pathNode, state) {
        const callee = pathNode.node.callee;
        if (callee.type !== 'Identifier') return;
        const isOurs = this.workerLocals.has(callee.name);
        const isGlobal = this.matchGlobal && WORKER_EXPORTS.has(callee.name);
        if (!isOurs && !isGlobal) return;

        const args = pathNode.node.arguments;
        if (args.length === 0) return;

        const first = args[0];
        // Skip inline sources and already-resolved refs.
        if (
          first.type === 'ObjectExpression' ||
          (first.type === 'CallExpression' &&
            first.callee.type === 'Identifier' &&
            first.callee.name.includes('workerRef'))
        ) {
          return;
        }

        const spec = stringFromNode(first) || specFromUrlExpression(first);
        if (spec == null) {
          // Dynamic argument: leave it; resolved against the manifest at runtime.
          return;
        }
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          // Bare package specifier — leave to runtime/manifest resolution.
          return;
        }

        const fromFile = state.file.opts.filename || 'unknown';
        const projectRoot = state.file.opts.root || process.cwd();
        const absPath = resolveEntry(spec, fromFile);
        const id = toEntryId(absPath, projectRoot);

        recordEntry(projectRoot, id, absPath, fromFile);

        if (!this.helperId) {
          this.helperId = addNamedImport(
            t,
            pathNode,
            '__workerRef',
            PACKAGE_NAME
          );
        }
        args[0] = t.callExpression(t.identifier(this.helperId), [
          t.stringLiteral(id),
        ]);
      },
    },
  };
};

// Inject `import { __workerRef as _uid } from '<pkg>'` once per file; returns the
// local name.
function addNamedImport(t, pathNode, name, source) {
  const program = pathNode.findParent((p) => p.isProgram());
  const uid = program.scope.generateUidIdentifier(name);
  const decl = t.importDeclaration(
    [t.importSpecifier(uid, t.identifier(name))],
    t.stringLiteral(source)
  );
  program.unshiftContainer('body', decl);
  return uid.name;
}
