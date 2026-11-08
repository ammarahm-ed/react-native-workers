---
sidebar_position: 3
title: Desktop (react-native-gpui)
---

# Desktop (react-native-gpui)

The library runs on desktop apps built with
[react-native-gpui](https://github.com/streetwriters/react-native-gpui): macOS
first, with Windows and Linux built from the same code but not yet tested. The
JavaScript API is the one on iOS and Android.

## Install

```bash
npm install @ammarahmed/react-native-workers
```

Autolinking builds the desktop side with the app: the C++ core is compiled into
the app, and every worker runs its own Hermes runtime on its own thread.

Metro on desktop is the `desktop` platform, so the Metro config is the app's
`desktop/metro.config.js`. Wrap it the same way:

```js
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');
module.exports = withWorkers(makeMetroConfig({ projectRoot }));
```

Add the Babel plugin as on mobile (`@ammarahmed/react-native-workers/plugin`).

## Workers from files

In development a worker file is fetched from Metro, as on mobile. In a release
build there is no Metro: `react-native-gpui`'s `run-desktop --release` and
`package-desktop` run this library's bundle hook, which builds one bundle for
each `new Worker('./file')` into the app's resource directory (`workers/`),
compiled to Hermes bytecode with the compiler of `@react-native-gpui/hermes`.
You do nothing extra. To build them by hand:

```bash
npx rn-workers-bundle --platform desktop --out desktop/build --config desktop/metro.config.js
```

## Native modules in a worker

A worker created with `nativeModules: true` can use the app's native modules:
the C++ modules, the Rust modules and core's own, each made again for the
worker's thread. Without the option only the modules written in C++ that
register themselves with ReactCommon (this library, for nested workers) are
visible, as on iOS and Android. Modules that belong to the main runtime or the
UI (`UIManager`, `AccessibilityInfo`, `BlobModule` and so on) are never served
to a worker.

## What is different from mobile

- **UI workers** (`UIWorker`) use the app's main thread through a desktop scheduler. They are implemented but have not been run on desktop yet.
- **`Blob`** is not available in a worker, as on mobile; use `SharedBuffer`.
- **Inspector**: worker runtimes are not debug targets on desktop yet.
- **Garbage collection checks.** Two of the library's own checks, that an
  unreferenced `SharedBuffer` or `SharedStore` is freed by a forced collection,
  do not hold on desktop's Hermes: a `SharedStore` is freed after a task has
  passed and a `SharedBuffer` is not freed in the time the check waits. Nothing
  about messaging is affected, but memory behind a dropped `SharedBuffer` is
  returned later than on mobile.
- Windows and Linux compile from the same files; only macOS has been run.

## Example and tests

`example-desktop/` in the repository is a desktop app that runs the library's
conformance, primitives and bridge suites plus desktop checks (a worker from its
own bundle, the app's native modules in a worker, eight workers at once). Its
end-to-end test launches it in the background, as react-native-gpui's tests do.
