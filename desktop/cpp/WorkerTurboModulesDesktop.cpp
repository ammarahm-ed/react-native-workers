// A worker's TurboModules on desktop: the modules react-native-gpui makes for
// the main runtime (the app's C++ modules, Rust modules and core's), made again
// for the worker's own CallInvoker, plus the C++ modules registered in
// ReactCommon's global map (which is how a nested worker finds this library).

#include "bindings/WorkerTurboModules.h"
#include "bindings/WorkerTurboModuleCompat.h"
#include "runtime/WorkerThreadScope.h"

#include "GpuiModules.h"

#include <ReactCommon/CxxTurboModuleUtils.h>
#include <ReactCommon/TurboModule.h>

#if defined(__APPLE__)
extern "C" void* objc_autoreleasePoolPush(void);
extern "C" void objc_autoreleasePoolPop(void*);
#endif

namespace facebook::react::workers {

#if defined(__APPLE__)
// A worker runs on a raw thread with no run loop or ambient pool, so an object
// autoreleased on it would be freed only at thread exit, after the runtime it
// might refer to is gone. The worker body owns a pool instead.
void installAppleAutoreleasePoolHooks() {
  setWorkerAutoreleasePoolHooks(
      +[]() -> void* { return objc_autoreleasePoolPush(); },
      +[](void* token) { objc_autoreleasePoolPop(token); });
}
#endif

std::function<void(jsi::Runtime&)> installWorkerTurboModules(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> workerInvoker,
    bool nativeModules) {
  rt.global().setProperty(rt, "RN$Bridgeless", jsi::Value(true));

  installWorkerTurboModuleBinding(
      rt,
      [workerInvoker,
       nativeModules](const std::string& name) -> std::shared_ptr<TurboModule> {
        if (isWorkerModuleDenied(name)) {
          return nullptr;
        }
        auto& cxxMap = globalExportedCxxTurboModuleMap();
        auto it = cxxMap.find(name);
        if (it != cxxMap.end()) {
          return it->second(workerInvoker);
        }
        // The platform's own modules are opt-in per worker, as on iOS and
        // Android: they cost memory and are not all safe off the main runtime.
        if (nativeModules) {
          return rngpui::createTurboModule(name, workerInvoker);
        }
        return nullptr;
      });
  return {};
}

} // namespace facebook::react::workers
