# Release-mode worker bundling

In development, `new Worker('./x')` is served straight from Metro over HTTP. In a
release build there is no Metro, so every worker entry must be pre-compiled into
its own standalone JS bundle and shipped inside the app. This document covers the
tooling that produces those bundles.

## How it works

1. **Discovery at transform time.** The Babel plugin (`plugin/index.js`) rewrites
   `new Worker('./x')` into `new Worker(__workerRef('<id>'))` and appends a line to
   a journal at `<projectRoot>/.rn-workers/manifest.log` for every worker it sees.
   Each line is one JSON object: `{"id","absPath","requestedFrom"}`. The `id` is
   the project-relative path without extension (posix separators).

2. **Bundling.** The `rn-workers-bundle` CLI (`cli/index.js`) reads and compacts
   that journal into a deduped list of entries. If the journal is empty or every
   entry in it is stale (a cold CI checkout, for instance), it falls back to a
   static AST scan of the project source (`src/**`, `app/**`, or the `--entry-file`
   directory) that finds both `new Worker('./x')` and
   `new Worker(new URL('./x', import.meta.url))`. Anything dropped or skipped is
   logged to stderr so truncation is never silent.

   For each entry it invokes Metro (via
   `@react-native/community-cli-plugin`'s `unstable_buildBundleWithConfig`, using
   the app's own Metro config) to emit `<out>/workers/<sanitized-id>.jsbundle`
   (+ `.map`). The file name is produced by the same `workerAssetName(id)` used at
   runtime in `src/resolveWorkerSource.ts`, so the two always agree:

   ```
   workerAssetName('src/workers/fib') === 'workers/src_workers_fib.jsbundle'
   ```

   It also writes `<out>/workers-manifest.json` mapping `id -> asset name`.

3. **Hermes (optional).** If `--hermes <path>` is given (or hermesc is found in the
   usual `node_modules/react-native/sdks/hermesc/<os>-bin/` location), each worker
   bundle is compiled to bytecode in place, keeping the `.jsbundle` name.

Any worker that fails to build fails the whole command — a broken release is worse
than a loud one. Only Hermes auto-location is best-effort.

## CLI usage

```
rn-workers-bundle --platform <ios|android> --out <dir> [options]
```

Run `node cli/index.js --help` for the full flag list. Run it from the app's
project root (or pass `--project-root`) so it resolves the app's Metro config and
reads the app's `.rn-workers/manifest.log`.

## Installation

### 1. Babel plugin

Add the plugin to the app's `babel.config.js` so the journal gets populated as the
main bundle is built:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['@ammarahmed/react-native-workers/plugin'],
};
```

### 2. Android

Apply the Gradle script from `android/app/build.gradle`, after the
`com.facebook.react` plugin and its `react { }` block:

```groovy
apply plugin: "com.facebook.react"

react { /* … */ }

apply from: new File(
  ["node", "--print", "require.resolve('@ammarahmed/react-native-workers/package.json')"]
    .execute(null, rootDir).text.trim(),
  "../android/worker-bundles.gradle")
```

This registers a `bundle<Variant>WorkerJs` task for each release variant, runs the
CLI into a generated assets dir, wires that dir into the variant's source set, and
orders it after `createBundle<Variant>JsAndAssets` and before
`merge<Variant>Assets`. Debug variants are skipped.

### 3. iOS

Add a second "Run Script" build phase to the app target, placed **after** the
stock "Bundle React Native code and images" phase:

```sh
"$NODE_BINARY" --version >/dev/null 2>&1 || true
LIB=$("${NODE_BINARY:-node}" --print "require('path').dirname(require.resolve('@ammarahmed/react-native-workers/package.json', {paths: [process.env.PROJECT_DIR + '/..']}))")
/bin/sh "$LIB/scripts/ios-bundle-workers.sh"
```

The script mirrors `react-native-xcode.sh`'s skip logic (`SKIP_BUNDLING`,
Debug/simulator) and only runs for release configurations. It writes the worker
bundles into `$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH` (next to
`main.jsbundle`), Hermes-compiling them when Hermes is enabled.

## Limitations / notes

- **Native asset loading is the companion piece.** This tooling only *produces*
  the worker bundles and places them next to the main bundle. Actually reading a
  `workers/<id>.jsbundle` asset at runtime (from Android APK assets / iOS app
  resources) is the responsibility of the library's native asset loader; the two
  must stay in agreement on the `workerAssetName` naming scheme.
- **Product flavors (Android).** The Gradle script adds the generated dir to the
  variant-scoped source set, falling back to the build-type source set. Exotic
  flavor + build-type matrices may need a tweak.
- **Never-up-to-date (Android).** Because the worker entry set is resolved
  dynamically, the Gradle task marks itself never-up-to-date (logged) rather than
  risk a stale incremental build.
- **Shared assets.** Image/font assets referenced *only* from a worker are emitted
  to `assetsDest` alongside the bundle; assets shared with the app are already
  carried by the main bundle.
