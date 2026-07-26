#!/usr/bin/env node
'use strict';

/**
 * rn-workers-bundle
 *
 * Release-mode bundler for react-native-workers. Produces one standalone Metro
 * bundle per worker entry discovered at build time, named exactly like the
 * runtime asset name computed by `workerAssetName` in
 * `src/resolveWorkerSource.ts` — so the native asset loader can find each
 * worker bundle next to the app's `main.jsbundle`.
 *
 * Entry discovery has two sources, in order:
 *   1. The babel-plugin journal at `<cwd>/.rn-workers/manifest.log` (fast path;
 *      populated as Metro transforms the app for the main bundle).
 *   2. A static AST scan of the project source (cold-CI fallback), used when
 *      the journal is empty or every entry it lists has gone stale.
 *
 * All Metro/React-Native tooling is resolved from the *project* root (the app),
 * never from this library, because `@react-native/metro-config` and friends
 * live in the app's dependency tree.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PACKAGE_NAME = '@ammarahmed/react-native-workers';

// Keep this in sync with `workerAssetName` in src/resolveWorkerSource.ts.
function workerAssetName(id) {
  return 'workers/' + id.replace(/[^a-zA-Z0-9]+/g, '_') + '.jsbundle';
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const HELP = `rn-workers-bundle — build standalone release bundles for react-native-workers

Usage:
  rn-workers-bundle --platform <ios|android> --out <dir> [options]

Required:
  --platform <ios|android>   Target platform.
  --out <dir>                Output directory for worker bundles (should match
                             the main bundle's resources dir / assetsDest).

Options:
  --dev <bool>               Dev mode (default: false).
  --entry-file <path>        App entry file; also seeds discovery scan root.
  --minify <bool>            Force minify on/off (default: !dev).
  --reset-cache              Reset Metro's transform cache.
  --config <path>            Explicit metro.config.js path.
  --hermes <path>            hermesc binary; compile each bundle to bytecode.
                             When omitted, hermesc is auto-located best-effort.
  --project-root <dir>       Project root (default: current working directory).
  -h, --help                 Show this help.

Notes:
  * Produces <out>/workers/<sanitized-id>.jsbundle (+ .map) per worker.
  * Writes <out>/workers-manifest.json mapping id -> asset name.
  * Any worker that fails to build fails the whole command.
`;

function parseArgs(argv) {
  const args = {
    platform: undefined,
    dev: false,
    out: undefined,
    entryFile: undefined,
    minify: undefined,
    resetCache: false,
    config: undefined,
    hermes: undefined,
    hermesExplicit: false,
    projectRoot: process.cwd(),
    help: false,
  };

  const bool = (v) => v === true || v === 'true' || v === '1' || v === 'yes';

  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let inlineValue;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq !== -1) {
      inlineValue = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    // Reads the next token as a value (or the inline `--k=v` form).
    const next = () => (inlineValue !== undefined ? inlineValue : argv[++i]);

    switch (key) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--platform':
        args.platform = next();
        break;
      case '--dev':
        args.dev = bool(next());
        break;
      case '--out':
        args.out = next();
        break;
      case '--entry-file':
        args.entryFile = next();
        break;
      case '--minify':
        args.minify = bool(next());
        break;
      case '--reset-cache':
        // Flag; consume an explicit value only when written as --reset-cache=..
        args.resetCache = inlineValue !== undefined ? bool(inlineValue) : true;
        break;
      case '--config':
        args.config = next();
        break;
      case '--hermes':
        args.hermes = next();
        args.hermesExplicit = true;
        break;
      case '--project-root':
        args.projectRoot = next();
        break;
      default:
        console.error(`rn-workers-bundle: unknown argument "${key}"`);
        break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Dependency resolution (from the app, not this library)
// ---------------------------------------------------------------------------

function reqFrom(projectRoot, name) {
  return require(require.resolve(name, { paths: [projectRoot] }));
}

// ---------------------------------------------------------------------------
// Entry-id helpers (mirrors plugin/index.js)
// ---------------------------------------------------------------------------

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
  return path.extname(abs) ? abs : abs + '.js';
}

function toEntryId(absPath, projectRoot) {
  let rel = path.relative(projectRoot, absPath);
  rel = rel.split(path.sep).join('/');
  return rel.replace(/\.(native\.)?(t|j)sx?$/, '').replace(/\.(mjs|cjs)$/, '');
}

// ---------------------------------------------------------------------------
// Source 1: the babel-plugin journal
// ---------------------------------------------------------------------------

/**
 * Read + compact `.rn-workers/manifest.log` into a deduped list of
 * `{ id, absPath }`. Later lines win (the plugin appends on every transform).
 * Entries whose `absPath` no longer exists are dropped with a warning so
 * truncation is never silent.
 */
function readJournal(projectRoot) {
  const logPath = path.join(projectRoot, '.rn-workers', 'manifest.log');
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (_e) {
    return [];
  }

  const byId = new Map();
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_e) {
      console.error(
        `rn-workers-bundle: skipping malformed manifest line: ${trimmed.slice(0, 120)}`
      );
      continue;
    }
    if (obj && typeof obj.id === 'string' && typeof obj.absPath === 'string') {
      byId.set(obj.id, obj.absPath);
    }
  }

  const entries = [];
  for (const [id, absPath] of byId) {
    if (fs.existsSync(absPath)) {
      entries.push({ id, absPath });
    } else {
      console.error(
        `rn-workers-bundle: dropping stale journal entry "${id}" (missing: ${absPath})`
      );
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Source 2: static discovery scan (cold-CI fallback)
// ---------------------------------------------------------------------------

const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'ios',
  'android',
  'build',
  'lib',
  'dist',
  '.rn-workers',
]);

function collectSourceFiles(dir, out) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (IGNORE_DIRS.has(dirent.name)) continue;
      collectSourceFiles(full, out);
    } else if (dirent.isFile() && SCAN_EXTS.has(path.extname(dirent.name))) {
      out.push(full);
    }
  }
}

function stringFromNode(node) {
  return node && node.type === 'StringLiteral' ? node.value : null;
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

// Lightweight recursive AST walk — avoids a hard dep on @babel/traverse.
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/**
 * Scan project source for `new Worker('./x')` /
 * `new Worker(new URL('./x', import.meta.url))` and rebuild the entry list.
 * Matches both the imported `Worker` from the package and a bare global
 * `Worker` identifier.
 */
function discoverEntries(projectRoot, entryFile) {
  const parser = reqFrom(projectRoot, '@babel/parser');

  const roots = [];
  if (entryFile) roots.push(path.dirname(path.resolve(projectRoot, entryFile)));
  for (const name of ['src', 'app']) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) roots.push(candidate);
  }
  if (roots.length === 0) roots.push(projectRoot);

  const files = [];
  for (const root of roots) collectSourceFiles(root, files);

  const byId = new Map();
  for (const file of files) {
    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch (_e) {
      continue;
    }

    let ast;
    try {
      ast = parser.parse(code, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins: ['jsx', 'typescript', 'importMeta', 'classProperties'],
      });
    } catch (e) {
      console.error(
        `rn-workers-bundle: discovery could not parse ${file}: ${e.message}`
      );
      continue;
    }

    const workerLocals = new Set();
    walk(ast.program, (node) => {
      if (
        node.type === 'ImportDeclaration' &&
        node.source &&
        node.source.value === PACKAGE_NAME
      ) {
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            spec.imported &&
            spec.imported.name === 'Worker'
          ) {
            workerLocals.add(spec.local.name);
          }
        }
      }
    });

    walk(ast.program, (node) => {
      if (node.type !== 'NewExpression') return;
      const callee = node.callee;
      if (!callee || callee.type !== 'Identifier') return;
      if (!workerLocals.has(callee.name) && callee.name !== 'Worker') return;
      if (!node.arguments || node.arguments.length === 0) return;

      const first = node.arguments[0];
      const spec = stringFromNode(first) || specFromUrlExpression(first);
      if (spec == null) return;
      if (!spec.startsWith('.') && !spec.startsWith('/')) return;

      const absPath = resolveEntry(spec, file);
      if (!fs.existsSync(absPath)) {
        console.error(
          `rn-workers-bundle: discovery skipping "${spec}" in ${file} (resolved missing: ${absPath})`
        );
        return;
      }
      const id = toEntryId(absPath, projectRoot);
      byId.set(id, absPath);
    });
  }

  return Array.from(byId, ([id, absPath]) => ({ id, absPath }));
}

// ---------------------------------------------------------------------------
// Metro config loading (mirrors @react-native/community-cli-plugin loadMetroConfig)
// ---------------------------------------------------------------------------

// Replicates community-cli-plugin's getCommunityCliDefaultConfig: the resolver
// platform list and the InitializeCore prelude that `react-native bundle` uses.
function frameworkDefaults(ctx) {
  const outOfTreePlatforms = Object.keys(ctx.platforms).filter(
    (platform) => ctx.platforms[platform].npmPackageName
  );
  return {
    resolver: {
      platforms: [...Object.keys(ctx.platforms), 'native'],
    },
    serializer: {
      getModulesRunBeforeMainModule: () => [
        require.resolve(
          path.join(ctx.reactNativePath, 'Libraries/Core/InitializeCore'),
          { paths: [ctx.root] }
        ),
        ...outOfTreePlatforms.map((platform) =>
          require.resolve(
            `${ctx.platforms[platform].npmPackageName}/Libraries/Core/InitializeCore`,
            { paths: [ctx.root] }
          )
        ),
      ],
    },
  };
}

// Locate the package that supplies Metro's default config for this app.
//
// A bare React Native app has `@react-native/metro-config`. An **Expo** app does
// NOT — Expo ships its own (`expo/metro-config`), and its metro.config.js calls
// that one. Requiring the React Native package unconditionally is what made this
// CLI fail on every Expo project with "Cannot find module
// '@react-native/metro-config'".
function loadDefaultConfigProvider(projectRoot) {
  for (const name of ['@react-native/metro-config', 'expo/metro-config']) {
    try {
      return { name, mod: reqFrom(projectRoot, name) };
    } catch (_e) {
      // Try the next one.
    }
  }
  return null;
}

async function loadAppMetroConfig(projectRoot, opts) {
  const { loadConfigAsync } = reqFrom(
    projectRoot,
    '@react-native-community/cli-config'
  );
  const ctx = await loadConfigAsync({
    projectRoot,
    selectedPlatform: opts.platform,
  });

  const metro = reqFrom(projectRoot, 'metro');

  const provider = loadDefaultConfigProvider(projectRoot);
  if (provider) {
    // Prime the default-config module the same way the app's own bundling step
    // does, so worker bundles come out of the same pipeline as the main bundle.
    provider.mod.getDefaultConfig(ctx.root);
    // React Native-only hook (adds the InitializeCore prelude and the out-of-tree
    // platform list). Expo's module has no equivalent because its own
    // getDefaultConfig already applies them.
    if (typeof provider.mod.setFrameworkDefaults === 'function') {
      provider.mod.setFrameworkDefaults(frameworkDefaults(ctx));
    }
  } else {
    console.error(
      'rn-workers-bundle: no metro default-config package found ' +
        '(@react-native/metro-config or expo/metro-config); using the ' +
        "project's metro.config.js as-is."
    );
  }

  const config = await metro.loadConfig({
    cwd: ctx.root,
    resetCache: opts.resetCache,
    config: opts.config,
  });
  return config;
}

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

function hermesOsBin() {
  switch (process.platform) {
    case 'darwin':
      return 'osx-bin';
    case 'win32':
      return 'win64-bin';
    default:
      return 'linux64-bin';
  }
}

// Best-effort hermesc discovery, following the same locations react-native-xcode.sh
// and the RN Gradle plugin (detectOSAwareHermesCommand) look at. Returns a path
// or null.
//
// ORDER MATTERS, and not just for tidiness. Hermes bytecode is version-locked to
// the runtime that loads it, so the compiler MUST come from the same React
// Native as the app. Anything the app itself ships is therefore tried before
// anything node resolution might find: in a monorepo, a bare
// `require.resolve('hermes-compiler')` from an app whose own node_modules lacks
// it walks UP and silently returns a different React Native's compiler, which
// produces worker bundles the app's Hermes refuses to load.
//
// Layouts, newest first:
//   * RN >= 0.86 — the `hermes-compiler` npm package, a sibling of react-native.
//   * RN <= 0.85 — `react-native/sdks/hermesc/<os>-bin/`.
//   * Building Hermes from source — `react-native/sdks/hermes/build/bin/`.
function locateHermesc(projectRoot, reactNativePath) {
  const bin = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';

  // Resolve `hermes-compiler` starting from a given directory, or null.
  const npmCompilerFrom = (from) => {
    if (!from) return null;
    try {
      return path.join(
        path.dirname(
          require.resolve('hermes-compiler/package.json', { paths: [from] })
        ),
        'hermesc',
        hermesOsBin(),
        bin
      );
    } catch (_e) {
      return null;
    }
  };

  const candidates = [];

  // 1. Whatever the app's OWN react-native carries. These paths are inside
  //    reactNativePath, so they cannot come from a different RN copy.
  if (reactNativePath) {
    candidates.push(
      path.join(reactNativePath, 'sdks/hermesc', hermesOsBin(), bin),
      path.join(reactNativePath, 'sdks/hermes/build/bin', bin),
      // A sibling of react-native — same install, so still the app's own.
      npmCompilerFrom(reactNativePath)
    );
  }

  // 2. The project's own node_modules, by explicit path (no upward walk).
  candidates.push(
    path.join(
      projectRoot,
      'node_modules/react-native/sdks/hermesc',
      hermesOsBin(),
      bin
    ),
    path.join(
      projectRoot,
      'node_modules/react-native/sdks/hermes/build/bin',
      bin
    ),
    path.join(
      projectRoot,
      'node_modules/hermes-compiler/hermesc',
      hermesOsBin(),
      bin
    )
  );

  // 3. Last resort: normal node resolution from the project, which MAY walk up
  //    to a hoisted copy. Only reached when the app ships no compiler of its
  //    own, and the caller logs the path it settled on.
  candidates.push(npmCompilerFrom(projectRoot));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Hermes bytecode file magic (little-endian 0x1F1903C103BC1FC6), the same value
// Hermes itself sniffs for in evaluateJavaScript to pick the HBC path. We check
// it so the build can *state* whether a worker shipped as bytecode rather than
// leaving it to be discovered at runtime.
const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

function isHermesBytecode(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(HBC_MAGIC.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === HBC_MAGIC.length && head.equals(HBC_MAGIC);
  } catch (_e) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Compile a JS bundle to Hermes bytecode in place (keeps the .jsbundle name so
// it still matches workerAssetName). Throws on failure.
function compileHermes(hermesc, bundlePath, dev) {
  const hbc = bundlePath + '.hbc';
  execFileSync(
    hermesc,
    [
      '-emit-binary',
      '-max-diagnostic-width=80',
      dev ? '-Og' : '-O',
      '-out',
      hbc,
      bundlePath,
    ],
    { stdio: 'inherit' }
  );
  fs.renameSync(hbc, bundlePath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!args.platform) {
    throw new Error('--platform <ios|android> is required');
  }
  if (args.platform !== 'ios' && args.platform !== 'android') {
    throw new Error(
      `--platform must be "ios" or "android" (got "${args.platform}")`
    );
  }
  if (!args.out) {
    throw new Error('--out <dir> is required');
  }

  const projectRoot = path.resolve(args.projectRoot);
  const outDir = path.resolve(args.out);

  // 1. Gather worker entries: journal first, discovery fallback.
  let entries = readJournal(projectRoot);
  if (entries.length === 0) {
    console.error(
      'rn-workers-bundle: journal empty or stale — running discovery scan.'
    );
    entries = discoverEntries(projectRoot, args.entryFile);
  }

  if (entries.length === 0) {
    console.error(
      'rn-workers-bundle: no worker entries found; nothing to bundle.'
    );
    // Still emit an (empty) manifest so downstream steps have a stable file.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'workers-manifest.json'),
      JSON.stringify({}, null, 2) + '\n'
    );
    return;
  }

  console.error(
    `rn-workers-bundle: building ${entries.length} worker bundle(s) for ${args.platform}:`
  );
  for (const entry of entries) console.error(`  - ${entry.id}`);

  // 2. Load the app's Metro config once (reused across builds).
  const config = await loadAppMetroConfig(projectRoot, {
    platform: args.platform,
    resetCache: args.resetCache,
    config: args.config,
  });

  const { unstable_buildBundleWithConfig } = reqFrom(
    projectRoot,
    '@react-native/community-cli-plugin'
  );

  fs.mkdirSync(outDir, { recursive: true });

  // 3. Build each worker to <out>/<assetName> (+ .map). Any failure is fatal.
  const manifest = {};
  for (const entry of entries) {
    const assetName = workerAssetName(entry.id);
    const bundleOutput = path.join(outDir, assetName);
    const sourcemapOutput = bundleOutput + '.map';
    fs.mkdirSync(path.dirname(bundleOutput), { recursive: true });

    console.error(`rn-workers-bundle: bundling ${entry.id} -> ${assetName}`);

    try {
      await unstable_buildBundleWithConfig(
        {
          platform: args.platform,
          dev: args.dev,
          minify: args.minify,
          entryFile: entry.absPath,
          bundleOutput,
          sourcemapOutput,
          sourcemapUseAbsolutePath: false,
          assetsDest: outDir,
          // Marks this as a worker graph so `withWorkers()` swaps `react-native`
          // for the worker shim. Must match the flag `metroBundleUrl()` puts on
          // the dev-server URL, or release bundles would differ from dev.
          resolverOption: ['rnworkers=true'],
          unstableTransformProfile: undefined,
        },
        config
      );
    } catch (e) {
      throw new Error(
        `Failed to bundle worker "${entry.id}" (${entry.absPath}): ${e.stack || e.message}`
      );
    }

    manifest[entry.id] = assetName;
  }

  // 4. Optional Hermes compilation.
  let hermesc = args.hermes;
  if (!hermesc) {
    hermesc = locateHermesc(projectRoot, config.reactNativePath);
    if (hermesc) {
      console.error(`rn-workers-bundle: found hermesc at ${hermesc}`);
      // Bytecode is version-locked to the runtime. A compiler from outside the
      // app's own tree is usually a hoisted copy belonging to a different React
      // Native, and the bundles it emits will fail to load at runtime — a
      // failure that only shows up on device, so say so at build time.
      if (
        !path.resolve(hermesc).startsWith(path.resolve(projectRoot) + path.sep)
      ) {
        console.error(
          'rn-workers-bundle: WARNING that hermesc is outside this project. If it ' +
            'belongs to a different React Native version, the worker bundles it ' +
            'produces will not load. Pass --hermes <path> to pin the right one.'
        );
      }
    }
  }
  if (hermesc) {
    for (const entry of entries) {
      const bundlePath = path.join(outDir, workerAssetName(entry.id));
      try {
        compileHermes(hermesc, bundlePath, args.dev);
        const size = fs.statSync(bundlePath).size;
        console.error(
          `rn-workers-bundle: hermes-compiled ${entry.id} ` +
            `(${isHermesBytecode(bundlePath) ? 'bytecode' : 'PLAIN JS — magic missing'}, ${size} bytes)`
        );
      } catch (e) {
        if (args.hermesExplicit) {
          // Explicit request — treat as fatal.
          throw new Error(
            `Hermes compilation failed for "${entry.id}": ${e.message}`
          );
        }
        // Auto-located hermesc is best-effort; keep the plain JS bundle.
        console.error(
          `rn-workers-bundle: hermes compilation skipped for "${entry.id}" (${e.message})`
        );
      }
    }
  } else if (args.hermesExplicit) {
    throw new Error(`--hermes path not found: ${args.hermes}`);
  } else {
    // Worth shouting about: the app's own bundle is almost certainly bytecode
    // here, so plain-JS workers are an inconsistency, not a deliberate choice.
    console.error(
      'rn-workers-bundle: WARNING hermesc not located; leaving plain JS bundles. ' +
        'Pass --hermes <path> if this build uses Hermes.'
    );
  }

  const byteCoded = entries.filter((entry) =>
    isHermesBytecode(path.join(outDir, workerAssetName(entry.id)))
  ).length;
  console.error(
    `rn-workers-bundle: ${byteCoded}/${entries.length} worker bundle(s) are Hermes bytecode.`
  );

  // 5. Emit the worker manifest (id -> asset name).
  fs.writeFileSync(
    path.join(outDir, 'workers-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  console.error(
    `rn-workers-bundle: done — ${entries.length} bundle(s) in ${outDir}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`rn-workers-bundle: ${err.stack || err.message || err}`);
    process.exit(1);
  });
}

// Exported for testing / programmatic use.
module.exports = {
  workerAssetName,
  parseArgs,
  readJournal,
  discoverEntries,
  resolveEntry,
  toEntryId,
  main,
};
