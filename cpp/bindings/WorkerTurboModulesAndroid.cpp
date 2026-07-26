#include "WorkerTurboModules.h"

// Android platform (Java/Kotlin) TurboModules inside a worker runtime.
//
// Unlike iOS (which has a process-global ObjC module registry), Android resolves
// TurboModules from the app's ReactPackage list via a TurboModuleManagerDelegate.
// RN does not expose the host's live delegate, so the app hands us its packages
// once (WorkerTurboModules.initialize in Kotlin), from which we build a shared
// DefaultTurboModuleManagerDelegate. For each worker we then build worker-bound
// CallInvoker/RuntimeExecutor holders here in C++ and let the Kotlin bridge
// construct a per-worker TurboModuleManager; its init installs __turboModuleProxy
// onto THIS worker runtime, resolving the app's Java modules (and, via the global
// Cxx map, C++ modules — including this library, so nested workers keep working).
#if defined(__ANDROID__)

#include <fbjni/fbjni.h>

#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/CxxTurboModuleUtils.h>
#include <ReactCommon/RuntimeExecutor.h>
#include <ReactCommon/TurboModule.h>
#include <ReactCommon/TurboModuleBinding.h>

// RN JNI hybrids (headers reached via include dirs added in android/CMakeLists.txt).
#include "react/jni/JRuntimeExecutor.h"
#include "react/turbomodule/ReactCommon/CallInvokerHolder.h"
#include "react/turbomodule/ReactCommon/NativeMethodCallInvokerHolder.h"

#include "WorkerBlobCollector.h"
#include "WorkerTurboModuleCompat.h"

#include "../runtime/MainThreadScheduler.h"
#include "../runtime/WorkerAssetReader.h"
#include "../runtime/WorkerThreadScope.h"

#include <android/log.h>

#include <memory>
#include <string>
#include <thread>

#define RNWTM_LOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerTM", __VA_ARGS__)

namespace facebook::react::workers {

// Registers the Android Expo installer (defined in WorkerExpoModulesAndroid.cpp).
// Referencing it from the force-linked ThreadScopeRegistrar below pulls that
// otherwise-unreferenced object file into the final binary (static archives drop
// object files nothing references).
void ensureExpoAndroidInstallerRegistered();

using namespace facebook::jsi;

namespace {

constexpr const char* kBridgeClass =
    "com/ammarahmed/reactnativeworkers/WorkerTurboModules";

// Runs a native TurboModule method body inline on the worker JS thread (which is
// JVM-attached with the app class loader for the worker's lifetime). The
// request/response path of TurboModules is fine here; thread-affine or
// long-blocking modules would ideally use a dedicated native queue (follow-up).
class WorkerNativeMethodCallInvoker : public NativeMethodCallInvoker {
 public:
  void invokeAsync(const std::string&, NativeMethodCallFunc&& func) noexcept
      override {
    func();
  }
  void invokeSync(const std::string&, NativeMethodCallFunc&& func) override {
    func();
  }
};

// Cxx-only fallback, used when the app has not registered its packages. Mirrors
// the generic non-Apple path in WorkerTurboModules.cpp.
void installCxxOnly(Runtime& rt, std::shared_ptr<CallInvoker> workerInvoker) {
  installWorkerTurboModuleBinding(
      rt,
      [workerInvoker](const std::string& name) -> std::shared_ptr<TurboModule> {
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
}

// Registers, at library load, the runner that HermesWorkerHost uses to wrap the
// entire worker thread body so JNI FindClass resolves app classes for the
// worker's whole lifetime (install AND later module access). Also registers the
// Android main-thread scheduler factory used by UIWorker — the call forces
// MainThreadSchedulerAndroid.cpp (an otherwise-unreferenced object file in this
// static archive) to link and its factory to register.
struct ThreadScopeRegistrar {
  ThreadScopeRegistrar() {
    setWorkerThreadScopeRunner([](const std::function<void()>& body) {
      facebook::jni::ThreadScope::WithClassLoader(std::function<void()>(body));
    });
    installAndroidMainThreadSchedulerFactory();
    // Same linker-retention reason for the release worker-bundle asset reader.
    installAndroidWorkerAssetReaderFactory();
    // Same linker-retention reason for the Expo-in-worker installer.
    ensureExpoAndroidInstallerRegistered();
  }
};
ThreadScopeRegistrar g_threadScopeRegistrar;

} // namespace

// Builds the per-worker Java TurboModuleManager and returns a global ref to it
// (safe to release from any thread), or null on failure. Runs on the worker
// thread inside the ThreadScope::WithClassLoader body (see the registrar below
// and WorkerThreadScope.h) so JNI FindClass resolves app + RN classes.
std::shared_ptr<_jobject> buildPlatformManager(
    Runtime& rt,
    const std::shared_ptr<CallInvoker>& workerInvoker) {
  try {
    auto cls = facebook::jni::findClassStatic(kBridgeClass);
    JNIEnv* env = facebook::jni::Environment::current();

    jmethodID isReady = env->GetStaticMethodID(cls.get(), "isReady", "()Z");
    if (!isReady ||
        env->CallStaticBooleanMethod(cls.get(), isReady) != JNI_TRUE) {
      RNWTM_LOG("buildPlatformManager: NOT READY (WorkerTurboModules.initialize "
                "not called yet) -> Cxx-only worker");
      return nullptr; // App has not registered its packages yet.
    }
    RNWTM_LOG("buildPlatformManager: ready, building per-worker manager");

    // A RuntimeExecutor that installs the binding onto THIS runtime. During
    // construction RN calls it synchronously on this (worker) thread, so we run
    // the callback inline with the current runtime; any later off-thread use
    // falls back to the worker CallInvoker.
    auto threadId = std::this_thread::get_id();
    Runtime* rtp = &rt;
    RuntimeExecutor exec =
        [rtp, workerInvoker, threadId](std::function<void(Runtime&)>&& cb) {
          if (std::this_thread::get_id() == threadId) {
            cb(*rtp);
          } else {
            workerInvoker->invokeAsync(
                [cb = std::move(cb)](Runtime& r) mutable { cb(r); });
          }
        };

    auto reHolder = JRuntimeExecutor::newObjectCxxArgs(exec);
    auto ciHolder = CallInvokerHolder::newObjectCxxArgs(workerInvoker);
    std::shared_ptr<NativeMethodCallInvoker> nmci =
        std::make_shared<WorkerNativeMethodCallInvoker>();
    auto nmciHolder = NativeMethodCallInvokerHolder::newObjectCxxArgs(nmci);

    jmethodID install = env->GetStaticMethodID(
        cls.get(),
        "installOnWorker",
        "(Lcom/facebook/react/bridge/RuntimeExecutor;"
        "Lcom/facebook/react/turbomodule/core/CallInvokerHolderImpl;"
        "Lcom/facebook/react/turbomodule/core/NativeMethodCallInvokerHolderImpl;"
        "J)"
        "Lcom/facebook/react/internal/turbomodule/core/TurboModuleManager;");
    if (!install) {
      RNWTM_LOG("buildPlatformManager: installOnWorker methodID NOT FOUND "
                "(signature/class mismatch)");
      env->ExceptionClear();
      return nullptr;
    }
    // The runtime pointer lets the Kotlin side build a per-worker
    // ReactApplicationContext that reports THIS runtime, so libraries installing
    // JSI bindings via `context.javaScriptContextHolder` target the worker.
    jobject managerLocal = env->CallStaticObjectMethod(
        cls.get(),
        install,
        reHolder.get(),
        ciHolder.get(),
        nmciHolder.get(),
        static_cast<jlong>(reinterpret_cast<uintptr_t>(&rt)));
    if (env->ExceptionCheck()) {
      RNWTM_LOG("buildPlatformManager: installOnWorker THREW");
      env->ExceptionDescribe();
      env->ExceptionClear();
      return nullptr;
    }
    if (!managerLocal) {
      RNWTM_LOG("buildPlatformManager: installOnWorker returned NULL");
      return nullptr;
    }
    RNWTM_LOG("buildPlatformManager: manager built OK");
    jobject managerGlobal = env->NewGlobalRef(managerLocal);
    env->DeleteLocalRef(managerLocal);
    // Deleter attaches the thread if needed, so the ref can be released even if
    // the owning callback is destroyed on an unattached (reap) thread.
    return std::shared_ptr<_jobject>(managerGlobal, [](jobject ref) {
      if (!ref) return;
      facebook::jni::ThreadScope ts;
      facebook::jni::Environment::current()->DeleteGlobalRef(ref);
    });
  } catch (const std::exception& e) {
    RNWTM_LOG("exception building platform manager: %s", e.what());
    return nullptr;
  }
}

std::function<void(Runtime&)> installWorkerTurboModules(
    Runtime& rt,
    std::shared_ptr<CallInvoker> workerInvoker,
    bool nativeModules) {
  // Workers run bridgeless, like the host. TurboModuleBinding::install() branches
  // on this flag: with it set, RN installs the `nativeModuleProxy` host object
  // that serves BOTH TurboModules and legacy (old-arch) modules. Without it we'd
  // get `__turboModuleProxy`, which drops the legacy provider entirely and would
  // make `NativeModules.Foo` unresolvable for non-codegen libraries.
  //
  // That proxy is defined READ-ONLY (non-writable, non-configurable), so it can't
  // be wrapped from here. The worker module denylist is therefore enforced one
  // level down, on the package list the TurboModuleManagerDelegate is built from
  // (WorkerTurboModules.kt) — denied modules are never constructed at all.
  rt.global().setProperty(rt, "RN$Bridgeless", Value(true));

  // The heavy Java TurboModuleManager is only built when the worker opts in.
  std::shared_ptr<_jobject> manager;
  if (nativeModules) {
    manager = buildPlatformManager(rt, workerInvoker);
  }

  if (!manager) {
    // Default / not-ready / failure: lightweight Cxx-only path. Nothing to tear
    // down (dies with the runtime).
    installCxxOnly(rt, std::move(workerInvoker));
    return {};
  }

  // BlobModule is served by our shim (WorkerBlobModule.kt), whose initialize()
  // is a no-op; the collector JS needs belongs on THIS runtime instead.
  installWorkerBlobCollector(rt);

  // Cleanup: invalidate the manager on the worker thread WHILE the runtime is
  // still alive (its modules hold jsi refs). Runs inside the WithClassLoader
  // body, so JNI is available. `manager` is released when this callback is
  // destroyed (its deleter is thread-safe).
  return [manager](Runtime&) {
    JNIEnv* env = facebook::jni::Environment::current();
    jclass cls = env->GetObjectClass(manager.get());
    jmethodID invalidate = env->GetMethodID(cls, "invalidate", "()V");
    if (invalidate) {
      env->CallVoidMethod(manager.get(), invalidate);
    }
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
    }
    env->DeleteLocalRef(cls);
  };
}

} // namespace facebook::react::workers

#endif // __ANDROID__
