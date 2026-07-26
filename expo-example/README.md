# react-native-workers × Expo example

A minimal **Expo (SDK 54, New Architecture)** app that verifies the library works
under an `expo prebuild` flow, wired through the library's Expo **config plugin**.

It is a workspace of this repo (`nmHoistingLimits: workspaces`, so it keeps its own
Expo/RN versions independent of the bare `example/`), and consumes the library from
source via its `ammarahmed-react-native-workers-source` export condition — no build
step needed.

## What it checks

The app boots straight into a probe screen that reports, at runtime:

| Row | Meaning |
| --- | --- |
| Host: expo-constants (main runtime) | Expo modules work on the host — sanity check |
| Worker: alive (roundtrip) | Workers run at all under Expo |
| Worker: RN/Cxx TurboModule reachable | Standard TurboModules/NativeModules resolve in a worker (this library's own Cxx module is the canary) |
| Worker: Expo Modules API installed | `global.expo.modules` exists in the worker runtime |
| Worker: Expo module constant (sync) | `ExpoDevice.osName` read synchronously in the worker |
| Worker: Expo module async function | `ExpoDevice.getDeviceTypeAsync()` invoked natively from the worker |

## Expo modules inside a worker

Standard React Native **TurboModules / NativeModules** work inside a worker
(`new Worker(src, { nativeModules: true })`), and so does the **Expo Modules API**:
`requireNativeModule('ExpoDevice')` works **directly** inside the worker.

The library installs its own `global.expo.modules` host object into the worker runtime
that forwards each call to the native side via Expo's public `AppContext` API
(constants from `expoModulesConfig`, functions via `callFunction`), so nothing crosses
runtimes. The probe screen reads a constant (`ExpoDevice.osName`) synchronously and
invokes an async function (`getDeviceTypeAsync()`) from the worker thread to prove it
end-to-end. Constants and functions work today; module-emitted events into a worker
are a follow-up.

## Run it

From the repo root:

```bash
yarn install                      # links the workspace
cd expo-example
yarn prebuild                     # expo prebuild --clean → generates android/ + ios/
yarn ios                          # or: yarn android
```

`expo prebuild` runs the library's config plugin, which:

- injects the one-time `WorkerTurboModules.initialize(...)` registration into the
  generated Android `MainApplication.kt` (so `{ nativeModules: true }` workers resolve
  the app's Java/Kotlin modules), and
- (with `releaseBundling: true` in `app.json`) wires the release worker-bundling step
  into the Android Gradle build and the iOS Xcode build phase.

iOS needs no native edits — all registration happens from `+load`, so autolinking +
`pod install` (run by prebuild) is enough.
