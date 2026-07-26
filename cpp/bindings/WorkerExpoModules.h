#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <functional>
#include <memory>

namespace facebook::react::workers {

// EXPERIMENTAL: install the Expo Modules API (`global.expo` + `requireNativeModule`)
// into a worker runtime.
//
// Expo modules are normally installed by expo-modules-core against a single
// AppContext bound to the app's MAIN runtime. But the install is just a sequence
// of per-runtime JSI operations (create the `expo` core object, install the
// EventEmitter/SharedObject/SharedRef/NativeModule base classes, then define
// `expo.modules` as an ExpoModulesHostObject backed by the app's module registry —
// see expo-modules-core AppContext.prepareRuntime()). None of it is intrinsically
// tied to WHICH runtime, and the async-function CallInvoker is per-install, so a
// worker install driven with the WORKER's CallInvoker stays thread-consistent.
//
// The platform layer (ios/WorkerExpoModules.mm, android/…) registers a real
// installer via setExpoModulesInstaller() at load time WHEN ExpoModulesCore is
// present; otherwise this is a no-op and workers simply have no `global.expo`.
//
// Caveats (see docs): pure request/response modules (expo-device, expo-crypto,
// expo-constants…) are the safe case. A module that stores a JS callback from one
// runtime and invokes it from another (some event emitters) or that keeps
// main-thread-only native state can misbehave; that is why this is opt-in.

// Signature of a platform installer: install Expo modules into `rt`, using
// `invoker` (the WORKER's CallInvoker) for async-function promise resolution.
// Returns a teardown thunk to be run ON THE WORKER THREAD right before the
// runtime is destroyed (empty when there is nothing to tear down — e.g. the iOS
// shim, which forwards to the app's shared AppContext and owns no per-worker
// state). Android returns a real cleanup: it builds a per-worker Expo AppContext
// whose coroutine queues / JNI refs / runtime binding must be released.
using ExpoModulesInstaller = std::function<std::function<void()>(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> invoker)>;

// Registered once by the platform layer at library load. Absent (null) when the
// app does not include ExpoModulesCore, or before the app has handed us its
// AppContext.
void setExpoModulesInstaller(ExpoModulesInstaller installer);

// Install Expo modules into `rt` if an installer is registered. Safe no-op
// otherwise. Called on the worker thread during worker startup. Returns the
// teardown thunk from the platform installer (empty if none / no installer).
std::function<void()> installExpoModulesInWorker(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> invoker);

} // namespace facebook::react::workers
