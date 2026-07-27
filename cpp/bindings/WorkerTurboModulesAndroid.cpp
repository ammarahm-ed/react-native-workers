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

#include <jsi/JSIDynamic.h>

// RN JNI hybrids (headers reached via include dirs added in android/CMakeLists.txt).
#include "react/jni/JRuntimeExecutor.h"
#include "react/jni/ReadableNativeArray.h"
#include "react/turbomodule/ReactCommon/CallInvokerHolder.h"
#include "react/turbomodule/ReactCommon/NativeMethodCallInvokerHolder.h"

#include "WorkerBlobCollector.h"
#include "WorkerTurboModuleCompat.h"

#include "../runtime/MainThreadScheduler.h"
#include "../runtime/WorkerNativeQueue.h"
#include "../runtime/WorkerAssetReader.h"
#include "../runtime/WorkerThreadScope.h"

#include <android/log.h>

#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

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

constexpr const char* kDeviceEmitterClass =
    "com/ammarahmed/reactnativeworkers/WorkerDeviceEventEmitter";

// ---------------------------------------------------------------------------
// Device-event sinks: a worker module's events go to the WORKER runtime.
//
// Kotlin's WorkerDeviceEventEmitter holds only an opaque id; the CallInvoker it
// resolves to lives here. Modules emit from their own threads (OkHttp, executors)
// and can outlive the worker, so the id is resolved under a lock on every emit and
// a missing entry simply drops the event.
// ---------------------------------------------------------------------------

struct DeviceEventSink {
  std::weak_ptr<CallInvoker> invoker;
};

std::mutex& sinkMutex() {
  static std::mutex m;
  return m;
}
std::unordered_map<long long, std::shared_ptr<DeviceEventSink>>& sinkRegistry() {
  static std::unordered_map<long long, std::shared_ptr<DeviceEventSink>> r;
  return r;
}

// Bound to WorkerDeviceEventEmitter.nativeEmit. Runs on whichever thread the
// module emitted from; only the payload marshalling happens here, the JSI work is
// posted onto the worker thread.
void emitDeviceEventNative(
    JNIEnv* env,
    jclass,
    jlong sinkId,
    jstring jEventName,
    jobject jArgs) {
  std::shared_ptr<DeviceEventSink> sink;
  {
    std::lock_guard<std::mutex> lock(sinkMutex());
    auto& r = sinkRegistry();
    auto it = r.find(static_cast<long long>(sinkId));
    if (it != r.end()) sink = it->second;
  }
  if (!sink) return; // worker already torn down — drop the event
  auto invoker = sink->invoker.lock();
  if (!invoker) return;

  std::string eventName;
  if (jEventName) {
    const char* chars = env->GetStringUTFChars(jEventName, nullptr);
    if (chars) {
      eventName = chars;
      env->ReleaseStringUTFChars(jEventName, chars);
    }
  }
  if (eventName.empty()) return;

  // The array was built fresh for this emit (WorkerDeviceEventEmitter.emit), so
  // consuming it is safe.
  folly::dynamic payload = folly::dynamic::array();
  try {
    if (jArgs) {
      auto nativeArray = jni::static_ref_cast<NativeArray::jhybridobject>(
          jni::wrap_alias(jArgs));
      payload = nativeArray->cthis()->consume();
    }
  } catch (const std::exception& e) {
    RNWTM_LOG("device event '%s': payload conversion failed: %s",
              eventName.c_str(), e.what());
    return;
  }

  auto args = std::make_shared<folly::dynamic>(std::move(payload));
  invoker->invokeAsync([args, eventName](Runtime& rt) {
    Value emitterVal = rt.global().getProperty(rt, "__rctDeviceEventEmitter");
    if (!emitterVal.isObject()) return;
    Object emitter = emitterVal.asObject(rt);
    Value emitVal = emitter.getProperty(rt, "emit");
    if (!emitVal.isObject() || !emitVal.asObject(rt).isFunction(rt)) return;

    std::vector<Value> jsArgs;
    jsArgs.emplace_back(String::createFromUtf8(rt, eventName));
    if (args->isArray()) {
      for (const auto& item : *args) {
        jsArgs.emplace_back(valueFromDynamic(rt, item));
      }
    }
    try {
      // A METHOD call: RN's RCTDeviceEventEmitterImpl keeps its listener registry
      // in a private field, so an undefined receiver throws (same reason RN's own
      // emitDeviceEvent uses callWithThis).
      // The const Value* cast selects the array overload rather than the
      // variadic template (which would try to convert the pointer itself).
      emitVal.asObject(rt).asFunction(rt).callWithThis(
          rt, emitter, static_cast<const Value*>(jsArgs.data()), jsArgs.size());
    } catch (const JSError& e) {
      RNWTM_LOG("device event '%s': listener threw: %s", eventName.c_str(),
                e.getMessage().c_str());
    }
  });
}

// Binds nativeEmit once. Called on the worker thread while JNI is attached with
// the app class loader (the library has no JNI_OnLoad of its own — same idiom as
// MainThreadScheduler).
bool ensureDeviceEmitterRegistered() {
  static bool ok = false;
  static std::once_flag once;
  std::call_once(once, [] {
    try {
      auto cls = facebook::jni::findClassStatic(kDeviceEmitterClass);
      JNIEnv* env = facebook::jni::Environment::current();
      static const JNINativeMethod methods[] = {
          {"nativeEmit",
           "(JLjava/lang/String;Lcom/facebook/react/bridge/WritableNativeArray;)V",
           reinterpret_cast<void*>(&emitDeviceEventNative)},
      };
      if (env->RegisterNatives(cls.get(), methods, 1) != JNI_OK) {
        if (env->ExceptionCheck()) {
          env->ExceptionDescribe();
          env->ExceptionClear();
        }
        RNWTM_LOG("RegisterNatives failed for WorkerDeviceEventEmitter.nativeEmit");
        return;
      }
      ok = true;
    } catch (const std::exception& e) {
      RNWTM_LOG("device emitter registration failed: %s", e.what());
    }
  });
  return ok;
}

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

long long registerWorkerDeviceEventSink(
    std::shared_ptr<CallInvoker> workerInvoker) {
  if (!ensureDeviceEmitterRegistered()) return 0;
  static long long nextId = 1;
  auto sink = std::make_shared<DeviceEventSink>();
  sink->invoker = workerInvoker;
  std::lock_guard<std::mutex> lock(sinkMutex());
  long long id = nextId++;
  sinkRegistry()[id] = std::move(sink);
  return id;
}

void unregisterWorkerDeviceEventSink(long long sinkId) {
  if (sinkId == 0) return;
  std::lock_guard<std::mutex> lock(sinkMutex());
  sinkRegistry().erase(sinkId);
}

// Builds the per-worker Java TurboModuleManager and returns a global ref to it
// (safe to release from any thread), or null on failure. Runs on the worker
// thread inside the ThreadScope::WithClassLoader body (see the registrar below
// and WorkerThreadScope.h) so JNI FindClass resolves app + RN classes.
std::shared_ptr<_jobject> buildPlatformManager(
    Runtime& rt,
    const std::shared_ptr<CallInvoker>& workerInvoker,
    long long deviceEventSinkId,
    const std::shared_ptr<WorkerNativeQueue>& nativeQueue,
    long long nativeQueueId) {
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
    // Module method bodies run on the worker's own native queue, never on its JS
    // thread — RN's model for the host, applied per worker.
    std::shared_ptr<NativeMethodCallInvoker> nmci =
        std::make_shared<WorkerNativeMethodCallInvoker>(nativeQueue);
    auto nmciHolder = NativeMethodCallInvokerHolder::newObjectCxxArgs(nmci);

    jmethodID install = env->GetStaticMethodID(
        cls.get(),
        "installOnWorker",
        "(Lcom/facebook/react/bridge/RuntimeExecutor;"
        "Lcom/facebook/react/turbomodule/core/CallInvokerHolderImpl;"
        "Lcom/facebook/react/turbomodule/core/NativeMethodCallInvokerHolderImpl;"
        "JJJ)"
        "Lcom/facebook/react/internal/turbomodule/core/TurboModuleManager;");
    if (!install) {
      RNWTM_LOG("buildPlatformManager: installOnWorker methodID NOT FOUND "
                "(signature/class mismatch)");
      env->ExceptionClear();
      return nullptr;
    }
    // The runtime pointer lets the Kotlin side build a per-worker
    // ReactApplicationContext that reports THIS runtime, so libraries installing
    // JSI bindings via `context.javaScriptContextHolder` target the worker. The
    // sink id gives that context a device-event target on THIS worker, so module
    // events never reach the host runtime.
    jobject managerLocal = env->CallStaticObjectMethod(
        cls.get(),
        install,
        reHolder.get(),
        ciHolder.get(),
        nmciHolder.get(),
        static_cast<jlong>(reinterpret_cast<uintptr_t>(&rt)),
        static_cast<jlong>(deviceEventSinkId),
        static_cast<jlong>(nativeQueueId));
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
  long long sinkId = 0;
  long long queueId = 0;
  std::shared_ptr<WorkerNativeQueue> nativeQueue;
  if (nativeModules) {
    // Both are registered BEFORE the manager: building it constructs the worker's
    // ReactContext, which needs the ids to serve module events and queue questions
    // from this worker rather than the host.
    sinkId = registerWorkerDeviceEventSink(workerInvoker);
    nativeQueue = std::make_shared<WorkerNativeQueue>();
    queueId = registerWorkerNativeQueue(nativeQueue);
    manager = buildPlatformManager(rt, workerInvoker, sinkId, nativeQueue, queueId);
  }

  if (!manager) {
    unregisterWorkerDeviceEventSink(sinkId);
    unregisterWorkerNativeQueue(queueId);
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
  //
  // The sink is dropped FIRST: a module may emit from its own thread while we're
  // invalidating, and dropping the sink makes that a no-op instead of a post onto
  // a runtime that is about to be destroyed.
  // `nativeQueue` is captured so the queue outlives the modules that post to it;
  // it stops and joins when this callback is destroyed, after invalidation.
  return [manager, sinkId, queueId, nativeQueue](Runtime&) {
    unregisterWorkerDeviceEventSink(sinkId);
    unregisterWorkerNativeQueue(queueId);
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
