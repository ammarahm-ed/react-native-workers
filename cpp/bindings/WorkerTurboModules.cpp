#include "WorkerTurboModules.h"

#include <string>
#include <unordered_set>

namespace facebook::react::workers {

// Modules that assume the main JS runtime / UI thread and must not be served to
// workers. TurboModuleRegistry.get -> null; getEnforcing -> a clear throw.
// Shared by the C++ (Cxx-only) path here and the iOS platform path (.mm).
bool isWorkerModuleDenied(const std::string& name) {
  static const std::unordered_set<std::string> kDeny = {
      "UIManager",
      "FabricUIManager",
      "SurfaceRegistry",
      "AccessibilityInfo",
      "DeviceEventManager",
      // Blob: BlobModule.initialize() installs a `__blobCollectorProvider`
      // HostFunction onto the *host* runtime (via the host context's
      // javaScriptContextHolder), capturing a jni::global_ref. Each worker that
      // creates BlobModule overwrites+orphans the previous provider, which the
      // host GC later releases on its (unattached) GC thread → native abort.
      // Denying BlobModule in workers stops it being created there, so no
      // provider is installed/orphaned. `Blob` is unavailable in workers (use
      // SharedBuffer for binary data). Upstream RN bug in BlobCollector.
      "BlobModule",
  };
  return kDeny.count(name) != 0;
}

} // namespace facebook::react::workers

// The default implementation serves Cxx modules only. Platform-specific
// implementations live elsewhere and this translation unit compiles to nothing
// there (avoiding a duplicate symbol):
//   - iOS:     ios/WorkerTurboModules.mm (RCTTurboModuleManager, ObjC modules)
//   - Android: cpp/bindings/WorkerTurboModulesAndroid.cpp (Java TurboModules)
#if !defined(__APPLE__) && !defined(__ANDROID__)

#include <ReactCommon/CxxTurboModuleUtils.h>
#include <ReactCommon/TurboModule.h>
#include <ReactCommon/TurboModuleBinding.h>

namespace facebook::react::workers {

using namespace facebook::jsi;

std::function<void(Runtime&)> installWorkerTurboModules(
    Runtime& rt,
    std::shared_ptr<CallInvoker> workerInvoker,
    bool /*nativeModules*/) {
  // No platform-module support here; always Cxx-only, nothing to tear down.
  rt.global().setProperty(rt, "RN$Bridgeless", Value(true));

  TurboModuleBinding::install(
      rt,
      [workerInvoker](Runtime& /*rt*/, const std::string& name)
          -> std::shared_ptr<TurboModule> {
        if (isWorkerModuleDenied(name)) {
          return nullptr;
        }
        auto& cxxMap = globalExportedCxxTurboModuleMap();
        auto it = cxxMap.find(name);
        if (it != cxxMap.end()) {
          return it->second(workerInvoker);
        }
        return nullptr;
      });
  return {};
}

} // namespace facebook::react::workers

#endif // !__APPLE__
