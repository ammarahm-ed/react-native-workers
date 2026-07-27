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

#if defined(__ANDROID__)
// Device-event sinks (WorkerTurboModulesAndroid.cpp).
//
// A worker's Java modules emit through `ReactContext.emitDeviceEvent`, which we
// serve from WorkerDeviceEventEmitter so the event lands on the WORKER runtime
// instead of the host's. Kotlin holds only an opaque id; these register/erase the
// record that maps it to the worker's CallInvoker.
//
// The id is looked up under a lock on every emit, so an event raised on a module's
// own thread after the worker is gone resolves to nothing and is dropped, rather
// than racing a destroyed runtime. Unregister on the worker thread during teardown.
long long registerWorkerDeviceEventSink(std::shared_ptr<CallInvoker> workerInvoker);
void unregisterWorkerDeviceEventSink(long long sinkId);
#endif

} // namespace facebook::react::workers
