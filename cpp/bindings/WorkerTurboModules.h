#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <functional>
#include <memory>

namespace facebook::react::workers {

// Installs the TurboModule binding into a worker runtime so worker JS can access
// native modules via global.__turboModuleProxy / nativeModuleProxy /
// TurboModuleRegistry.
//
// - iOS (ios/WorkerTurboModules.mm): a per-worker RCTTurboModuleManager resolves
//   ObjC modules (via the global RCT_EXPORT_MODULE registry) AND C++ (Cxx)
//   modules, each constructed with the WORKER's CallInvoker.
// - Android (cpp/bindings/WorkerTurboModulesAndroid.cpp): a per-worker
//   TurboModuleManager (built via the Kotlin WorkerTurboModules bridge from the
//   app's registered ReactPackages) resolves Java modules AND Cxx modules with
//   the WORKER's CallInvoker. Falls back to Cxx-only if the app didn't register.
// - Other platforms (WorkerTurboModules.cpp): Cxx modules only.
//
// The lightweight Cxx-only path (globalExportedCxxTurboModuleMap) is ALWAYS
// installed so nested workers + C++ modules work with near-zero cost. The heavy
// platform (Java/ObjC) manager is only built when `nativeModules` is true (opt-in
// per worker) — it costs memory and requires teardown.
//
// UI-affine modules are denylisted. Returns a cleanup callback that MUST be run
// on the worker thread with the runtime still alive, right before teardown (it
// invalidates the platform manager). Empty when no platform manager was built.
std::function<void(jsi::Runtime&)> installWorkerTurboModules(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> workerInvoker,
    bool nativeModules);

// Shared denylist (UI-affine / main-runtime-only modules) — defined in the .cpp.
bool isWorkerModuleDenied(const std::string& name);

} // namespace facebook::react::workers
