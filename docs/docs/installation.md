---
sidebar_position: 2
title: Installation
---

# Installation

## 1. Install the package

```bash
npm install @ammarahmed/react-native-workers
# or: yarn add @ammarahmed/react-native-workers
```

The library ships native C++/Kotlin/Objective-C, so it's autolinked — no manual
linking. You must be on the **New Architecture** with **Hermes** (RN 0.81.4+).

### iOS

```bash
cd ios && pod install
```

### Android

Nothing extra to build — autolinking picks up the module. If you want workers to
access your app's **platform (Java/Kotlin) native modules**, do the one-time
registration in the next section.

## 2. Add the Metro config

Wrap your app's Metro config with `withWorkers()`:

```js title="metro.config.js"
const { getDefaultConfig } = require('@react-native/metro-config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

module.exports = withWorkers(getDefaultConfig(__dirname));
```

This is strongly recommended for any app whose workers touch native modules.
Each worker is bundled as its own Metro graph, so `import … from 'react-native'`
pulls the **entire framework** — the Fabric renderer, the component library,
Animated, virtualized-lists — into every worker that reaches it. None of it is
usable on a runtime with no view tree, and you cannot avoid it by writing careful
worker code, because third-party native modules import the barrel themselves.

`withWorkers()` makes `react-native` resolve to a worker-sized shim *inside
worker graphs only* — your app's own bundle is untouched. Sizes below are Hermes
bytecode, minified, from the example app:

| worker | without | with |
| --- | --- | --- |
| `react-native-gzip` (legacy module) | 1.39 MB | **149 KB** |
| `react-native-mmkv` (Nitro) | 1.42 MB | **302 KB** |
| `react-native-blob-util` (TurboModule) | 1.50 MB | **264 KB** |
| a worker that imports nothing | 17.8 KB | 17.8 KB |

The shim provides what a worker can actually use — `Platform`, `NativeModules`,
`TurboModuleRegistry`, the event emitters, `Blob`/`FormData`/`XMLHttpRequest`,
`AppState`, `Linking`. Anything else (`View`, `StyleSheet`, `Animated`, hooks…)
throws on access with a message naming the export, rather than being silently
`undefined`.

Two options are available:

```js
// Drops Blob/FormData/XMLHttpRequest/AppState/Linking for ~86 KB less per
// worker. Excluded names still throw a message saying which tier they live in.
withWorkers(config, { shim: 'minimal' });

// Escape hatch: no shim at all, so workers embed the whole framework again.
withWorkers(config, { shim: false });
```

Worker graphs are tagged with a custom resolver option that the dev server and
the release CLI both set, so a worker bundles identically in development and in
release. See the [Bundling guide](./guides/bundling) for the full picture.

## 3. Add the Babel plugin

Workers are normally written **in their own files** and loaded by path
(`new Worker('./workers/task')`) — that's the primary way to use them. The Babel
plugin is what compiles each worker file into its own bundle, so add it to your
app's `babel.config.js`:

```js title="babel.config.js"
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
};
```

(You can skip this if you only ever use small inline-string workers, but most real
workers live in files.) See the [Bundling guide](./guides/bundling) for how this
works and for release builds.

## 4. (Optional) Register native modules on Android

C++ (Cxx) modules and nested workers work out of the box. To let workers reach
your app's **Java/Kotlin** native modules, register your packages once when the
React context is ready (Android has no global native-module registry, unlike iOS):

```kotlin title="MainApplication.kt"
import com.ammarahmed.reactnativeworkers.WorkerTurboModules
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext

// after super.onCreate(), once you have the ReactHost:
reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener {
  override fun onReactContextInitialized(context: ReactContext) {
    if (context is ReactApplicationContext) {
      WorkerTurboModules.initialize(
        context,
        PackageList(this@MainApplication).packages,
      )
    }
  }
})
```

RN's **core** modules (`SourceCode`, `PlatformConstants`, `DeviceInfo`, …) are
added automatically. See [Native modules in workers](./guides/native-modules) for
details. On **iOS no setup is required** — a per-worker `RCTTurboModuleManager`
resolves any registered ObjC module via the global registry.

## Expo

The library works in an Expo app that uses a **development build** (custom native
code, so **not** Expo Go) with the New Architecture — the default on SDK 52+.
`expo prebuild` runs `pod install` and Gradle autolinking, and all iOS native
registration happens from `+load`, so **iOS needs no project edits at all**.

Steps 2 (Metro) and 3 (Babel) are the same, adapted to Expo's presets:

```js title="metro.config.js"
const { getDefaultConfig } = require('expo/metro-config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

module.exports = withWorkers(getDefaultConfig(__dirname));
```

```js title="babel.config.js"
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
  };
};
```

The Android `MainApplication` registration (step 4) and the release worker-bundling
wiring can't be hand-edited in a managed/prebuild app, so the library ships an
**Expo config plugin** that does them at prebuild time. Add it to `app.json`:

```json title="app.json"
{
  "expo": {
    "plugins": [
      ["@ammarahmed/react-native-workers", {
        "androidNativeModules": true,
        "releaseBundling": false
      }]
    ]
  }
}
```

- **`androidNativeModules`** (default `true`) — injects the one-time
  `WorkerTurboModules.initialize(...)` call into the generated `MainApplication`, so
  `new Worker(src, { nativeModules: true })` can reach your app's Java/Kotlin modules.
  Harmless when unused; set `false` to skip it.
- **`releaseBundling`** (default `false`) — wires the ahead-of-time worker-bundle
  build into the Android Gradle build and the iOS Xcode build phase. Enable it if you
  use **file-based workers** (`new Worker('./file')`) and ship release builds.

Then:

```bash
npx expo prebuild --clean
npx expo run:ios     # or: npx expo run:android
```

A runnable reference lives in [`expo-example/`](https://github.com/ammarahm-ed/ammarahmed-react-native-workers/tree/main/expo-example).

### Expo modules inside a worker

Standard **TurboModules / NativeModules** work inside a worker, and so does the
**Expo Modules API** — `requireNativeModule(...)` works directly inside a worker on
**both iOS and Android** when the worker opts into native modules:

```js
const w = new Worker('./worker', { nativeModules: true });
// inside the worker:
const Device = requireNativeModule('ExpoDevice');
Device.osName;                        // constants — read synchronously
await Device.getDeviceTypeAsync();    // async functions — invoked natively
const Crypto = requireNativeModule('ExpoCrypto');
Crypto.randomUUID();                  // sync functions — return a value directly

const Foo = requireNativeModule('SomeModule');
Foo.someProperty;                     // dynamic properties — read live
const sub = Foo.addListener('onEvent', (payload) => { /* ... */ }); // events
sub.remove();
```

The full module surface works: **constants**, **sync + async functions**, **live
properties**, and module-emitted **events**. Nothing crosses runtimes, so it's
crash-safe. The library uses a different strategy per platform:

- **iOS** — Expo's `AppContext` is bound to the app's main runtime and the
  Swift↔C++ boundary prevents binding a second one to a worker. So the library
  installs its **own** `global.expo.modules` host object in the worker runtime that
  forwards every call natively through Expo's public `AppContext` API. Events and
  live properties are bridged from the main runtime on the main thread and delivered
  back on the worker thread. The app's `AppContext` is captured automatically by a
  companion Expo module the library ships — no app wiring.
- **Android** — Expo's JNI install takes a raw runtime pointer, so the library builds
  a real, **per-worker `AppContext`** and lets Expo install `global.expo` against the
  worker runtime directly. Every feature runs through Expo's own native
  implementation, with per-worker module instances (like this library's per-worker
  TurboModules).

This compiles to nothing in non-Expo apps.

:::note[Per-worker module instances on Android]
On Android each worker re-instantiates the app's Expo modules (its own `AppContext`).
This is ideal for request/response modules (device, crypto, constants, file-system…).
A module that keeps process-wide native state or registers global system listeners in
its `OnCreate` may do so once per worker — prefer calling those on the main runtime.
:::

## Verify

```js
import { Worker } from '@ammarahmed/react-native-workers';

const w = new Worker({ inline: `self.onmessage = e => self.postMessage(e.data + 1);` });
w.onmessage = (e) => console.log('worker replied:', e.data); // 42
w.postMessage(41);
```

If you see `worker replied: 42`, you're set. Continue to the
[Quick start](./quick-start).
