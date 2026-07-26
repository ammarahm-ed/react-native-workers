---
sidebar_position: 6
title: Bundling file workers
---

# Bundling file workers

Inline workers need no build setup. **File workers** (`new Worker('./task')`) do —
each worker is a separate program that must be compiled into its own bundle. This
page explains the Babel plugin and how loading differs in dev vs release.

## The Babel plugin

Add it to your app's Babel config:

```js title="babel.config.js"
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
};
```

The plugin scans for `new Worker('./relative/path')` calls with a **string
literal** relative path, and:

1. records each referenced worker file in a manifest;
2. rewrites the call so the runtime knows how to load that worker's bundle.

```js
// you write:
const w = new Worker('./workers/heavy');

// the plugin rewrites it to a descriptor the runtime resolves at load time.
```

Only relative string literals are rewritten. `new Worker({ inline })` and
`new Worker(someVariable)` are left alone.

## Development

In dev, the runtime loads a worker by **fetching its bundle from Metro** over HTTP
and running it inline. This means:

- fast refresh of worker code works like the rest of your app;
- no extra build step during development.

Just run your app normally (`react-native start` + run the app).

## Release builds

For release, there's no Metro server, so each worker bundle must be **built ahead
of time** and shipped with the app.

### Expo

Managed Expo apps have no `build.gradle` or Xcode project to edit, so the config
plugin does both for you. Turn it on with `releaseBundling`:

```json title="app.json"
{
  "expo": {
    "plugins": [
      ["@ammarahmed/react-native-workers", { "releaseBundling": true }]
    ]
  }
}
```

Then `npx expo prebuild` and build as usual. The plugin adds the Gradle apply and
the Xcode build phase described below; nothing else is needed.

:::note
This only affects **release** builds. Development still fetches worker bundles
from Metro, so you will not see any difference until you build for release.
:::

### Bare React Native

Wire the bundling step into your native build:

- **Android** — apply the Gradle script from `android/app/build.gradle`, after the
  `react { }` block. Let node resolve the package rather than hard-coding a path,
  so it keeps working when `node_modules` is hoisted:

  ```groovy title="android/app/build.gradle"
  apply from: new File(
    ["node", "--print", "require.resolve('@ammarahmed/react-native-workers/package.json')"]
      .execute(null, rootDir).text.trim(),
    "../android/worker-bundles.gradle")
  ```

  This registers a `bundle<Variant>WorkerJs` task for each release variant and
  wires its output into the variant's assets. Debug variants are skipped.

- **iOS** — add a "Run Script" build phase **after** the stock
  *Bundle React Native code and images* phase (that phase creates the resources
  directory this one writes into):

  ```sh title="Xcode ▸ Build Phases ▸ [RN Workers] Bundle worker code"
  set -e
  WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"
  WORKERS_SCRIPT="$("$NODE_BINARY" --print \
    "require('path').dirname(require.resolve('@ammarahmed/react-native-workers/package.json'))")/scripts/ios-bundle-workers.sh"

  /bin/sh -c "\"$WITH_ENVIRONMENT\" \"$WORKERS_SCRIPT\""
  ```

  It mirrors `react-native-xcode.sh`'s skip logic, so it is a no-op for Debug on
  the Simulator, and picks up `hermesc` from the `hermes-engine` pod.

The CLI that produces the per-worker bundles is also runnable directly:

```bash
npx rn-workers-bundle --platform ios --out <dir>   # or --platform android
```

:::tip[Consuming the library from source]
In a workspace that resolves `@ammarahmed/react-native-workers` through Metro
aliases rather than `node_modules`, `require.resolve` will fail. Set
`RN_WORKERS_PACKAGE_ROOT` to the package directory and the iOS script will use it
instead; on Android, `apply from:` a direct relative path.
:::

### How a bundled worker loads

Each bundle is **Hermes-compiled to bytecode** when the build uses Hermes, exactly
like your app's own `main.jsbundle` — so workers start without a parse step.

End to end, `new Worker('./workers/parse')` in a release build resolves like this:

1. The babel plugin has already rewritten the call to reference the worker's
   **entry id** — its path relative to the project root, e.g. `src/workers/parse`.
2. At runtime the id is turned into an **asset name** by replacing every
   non-alphanumeric run with `_`: `workers/src_workers_parse.jsbundle`. The
   release CLI names its output with the same rule, which is what makes the two
   sides meet.
3. The C++ core asks the platform asset reader for those bytes — `NSBundle` on
   iOS, the APK's `AssetManager` on Android. There is no app-side setup for this;
   the library registers its own reader (on Android via a content provider that
   captures the application context at process start).
4. The bytes are handed to the worker's Hermes runtime as-is. **Nothing branches
   on the format**: Hermes sniffs the bytecode magic in `evaluateJavaScript` and
   takes the HBC path, or parses it as JS if it isn't bytecode. That is why the
   files keep the `.jsbundle` name whether or not `hermesc` ran, and why the
   reader deals in raw bytes rather than a string.

Because the format is detected rather than declared, a worker that silently
shipped as plain JS still *runs* — it just loses the bytecode startup win. The
checks below are how you tell the two apart.

### Checking a release build

The bundling step reports what it produced, and ends with a bytecode tally:

```
rn-workers-bundle: hermes-compiled src/workers/parse (bytecode, 24013 bytes)
rn-workers-bundle: 15/15 worker bundle(s) are Hermes bytecode.
```

If you see `WARNING hermesc not located`, the workers shipped as plain JS while
your app bundle is bytecode — pass `--hermes <path>` to the CLI.

At runtime each bundled worker logs how it loaded, under the `RNWorkerAsset` tag
(`adb logcat -s RNWorkerAsset` on Android, the device console on iOS):

```
[RNWorkerAsset] loaded 'workers/src_workers_parse.jsbundle' (24013 bytes, hermes bytecode) -> worker 3
```

## Tips

- Keep worker files small and dependency-light — every import is bundled into the
  worker, not shared with your app bundle.
- Prefer **inline** workers for tiny one-off tasks and **file** workers for
  anything you'd want to unit-test or reuse.
