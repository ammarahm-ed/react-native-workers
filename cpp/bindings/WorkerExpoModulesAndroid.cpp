// Android: install the Expo Modules API (`global.expo`) into a WORKER Hermes
// runtime by building a real, per-worker Expo `AppContext` and letting
// expo-modules-core's own JNI (`JSIContext.installJSIForBridgeless`) install
// `global.expo` against the worker runtime.
//
// Both platforms now build a REAL per-worker AppContext (iOS does it through
// ExpoRuntime + the Swift factory — see ios/WorkerExpoModules.mm). Android's
// install entry point takes a RAW jsi::Runtime pointer + a RuntimeExecutor. We already build those per worker for
// TurboModules (WorkerTurboModulesAndroid.cpp), so here we build the same worker
// holders and pass them to the Kotlin bridge `WorkerExpoModules.installOnWorker`,
// which constructs the AppContext and installs Expo entirely through Expo's own
// Kotlin/JNI machinery. That means functions (sync + async), events, properties
// and binary all work via Expo's real implementation — no marshalling of ours.
//
// This file is ALWAYS compiled (no ExpoModulesCore headers are needed — the work
// is 100% on the Kotlin side). When the app is not an Expo app, the Kotlin class
// is absent / `isReady()` is false and the installer is a graceful no-op.

#if defined(__ANDROID__)

#include "WorkerExpoModules.h"
#include "WorkerTurboModules.h"

#include "../runtime/WorkerNativeQueue.h"

#include <fbjni/fbjni.h>

#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/RuntimeExecutor.h>

// RN JNI hybrids (headers reached via include dirs added in android/CMakeLists.txt).
#include "react/jni/JRuntimeExecutor.h"
#include "react/turbomodule/ReactCommon/CallInvokerHolder.h"

#include <android/log.h>

#include <functional>
#include <memory>
#include <thread>

#define RNWEXPO_ALOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerExpo", __VA_ARGS__)

namespace facebook::react::workers {

namespace {

constexpr const char* kBridgeClass =
    "com/ammarahmed/reactnativeworkers/WorkerExpoModules";

// A global ref whose deleter re-attaches the (possibly reaped) thread before
// releasing — mirrors the pattern in WorkerTurboModulesAndroid.cpp.
std::shared_ptr<_jobject> retainGlobal(jobject local) {
  JNIEnv* env = facebook::jni::Environment::current();
  jobject global = env->NewGlobalRef(local);
  return std::shared_ptr<_jobject>(global, [](jobject ref) {
    if (!ref) return;
    facebook::jni::ThreadScope ts;
    facebook::jni::Environment::current()->DeleteGlobalRef(ref);
  });
}

// Runs on the worker JS thread (the whole worker body runs inside
// ThreadScope::WithClassLoader — see WorkerTurboModulesAndroid.cpp — so JNI
// FindClass resolves app + Expo classes). Builds the per-worker Expo AppContext
// via the Kotlin bridge and returns a teardown thunk (empty on failure / no Expo).
std::function<void()> installExpoOnAndroidWorker(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> workerInvoker) {
  try {
    JNIEnv* env = facebook::jni::Environment::current();

    // The Kotlin bridge only exists in Expo apps (it's in a conditionally-compiled
    // source set). Use raw FindClass (+ ExceptionClear) rather than findClassStatic
    // so a non-Expo app is a quiet no-op, not a thrown/caught exception per worker.
    jclass rawCls = env->FindClass(kBridgeClass);
    if (!rawCls) {
      env->ExceptionClear();
      RNWEXPO_ALOG("WorkerExpoModules class absent (non-Expo app) -> no-op");
      return {};
    }
    // Scoped: this function has six early returns and the local ref was leaked on
    // every one of them, on a thread that lives as long as the worker.
    struct LocalRefGuard {
      JNIEnv* env;
      jobject ref;
      ~LocalRefGuard() {
        if (ref) env->DeleteLocalRef(ref);
      }
    } clsGuard{env, rawCls};
    jclass cls = rawCls;

    // Also requires the host to have registered its React context
    // (WorkerTurboModules.initialize) and the app to be an Expo app.
    jmethodID isReady = env->GetStaticMethodID(cls, "isReady", "()Z");
    if (!isReady ||
        env->CallStaticBooleanMethod(cls, isReady) != JNI_TRUE) {
      env->ExceptionClear();
      RNWEXPO_ALOG(
          "installOnWorker: not ready (WorkerTurboModules.initialize not called "
          "or Expo module list unresolved) -> no global.expo in this worker");
      return {};
    }

    // A RuntimeExecutor that installs onto THIS worker runtime. Expo uses it to
    // hop async-function results back onto the worker JS thread. Runs inline when
    // already on the worker thread; otherwise defers through the worker invoker.
    auto threadId = std::this_thread::get_id();
    jsi::Runtime* rtp = &rt;
    RuntimeExecutor exec =
        [rtp, workerInvoker, threadId](std::function<void(jsi::Runtime&)>&& cb) {
          if (std::this_thread::get_id() == threadId) {
            cb(*rtp);
          } else {
            workerInvoker->invokeAsync(
                [cb = std::move(cb)](jsi::Runtime& r) mutable { cb(r); });
          }
        };
    auto reHolder = JRuntimeExecutor::newObjectCxxArgs(exec);
    auto ciHolder = CallInvokerHolder::newObjectCxxArgs(workerInvoker);

    jmethodID install = env->GetStaticMethodID(
        cls,
        "installOnWorker",
        "(Lcom/facebook/react/bridge/RuntimeExecutor;"
        "Lcom/facebook/react/turbomodule/core/CallInvokerHolderImpl;"
        "JJJ)"
        "Ljava/lang/Object;");
    if (!install) {
      RNWEXPO_ALOG("installOnWorker: methodID NOT FOUND (signature mismatch)");
      env->ExceptionClear();
      return {};
    }

    // The Expo AppContext builds its own worker ReactContext, so it needs its own
    // device-event target too — an Expo module using the legacy `emitDeviceEvent`
    // path must not reach the host runtime either.
    long long sinkId = registerWorkerDeviceEventSink(workerInvoker);
    // The Expo context answers queue questions for the SAME worker, so it shares
    // the TurboModule path's queue when there is one; standalone (Expo without
    // `nativeModules: true`) there is none and it defers to the host.
    //
    // This used to be hardcoded to 0 while the comment claimed otherwise, so an
    // Expo module calling runOnNativeModulesQueueThread inside a worker landed on
    // the HOST's NativeModules thread — the shared-thread dependency the queue
    // exists to remove.
    long long queueId = workerNativeQueueIdForRuntime(&rt);

    jobject handleLocal = env->CallStaticObjectMethod(
        cls,
        install,
        reHolder.get(),
        ciHolder.get(),
        static_cast<jlong>(reinterpret_cast<uintptr_t>(&rt)),
        static_cast<jlong>(sinkId),
        static_cast<jlong>(queueId));
    if (env->ExceptionCheck()) {
      RNWEXPO_ALOG("installOnWorker: THREW");
      env->ExceptionDescribe();
      env->ExceptionClear();
      unregisterWorkerDeviceEventSink(sinkId);
      return {};
    }
    if (!handleLocal) {
      RNWEXPO_ALOG("installOnWorker: returned null (install failed)");
      unregisterWorkerDeviceEventSink(sinkId);
      return {};
    }
    RNWEXPO_ALOG("installOnWorker: global.expo installed against worker runtime");

    std::shared_ptr<_jobject> handle = retainGlobal(handleLocal);
    env->DeleteLocalRef(handleLocal);

    // Teardown thunk: run on the worker JS thread in Worker.cpp's setPreDestroy
    // (runtime still alive). Releases the per-worker AppContext (Kotlin onDestroy)
    // and unbinds the worker runtime's JSIContext — both must run on this thread.
    return [handle, sinkId]() {
      unregisterWorkerDeviceEventSink(sinkId);
      try {
        facebook::jni::ThreadScope ts;
        auto cls = facebook::jni::findClassStatic(kBridgeClass);
        JNIEnv* env = facebook::jni::Environment::current();
        jmethodID teardown = env->GetStaticMethodID(
            cls.get(), "teardown", "(Ljava/lang/Object;)V");
        if (teardown) {
          env->CallStaticVoidMethod(cls.get(), teardown, handle.get());
          if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
          }
        }
      } catch (const std::exception& e) {
        RNWEXPO_ALOG("teardown threw: %s", e.what());
      } catch (...) {
        RNWEXPO_ALOG("teardown threw (non-std)");
      }
    };
  } catch (const std::exception& e) {
    RNWEXPO_ALOG("installOnWorker exception: %s", e.what());
    return {};
  } catch (...) {
    RNWEXPO_ALOG("installOnWorker exception (non-std)");
    return {};
  }
}

} // namespace

// Registers the Android Expo installer into the shared slot. Idempotent.
//
// This is ALSO the linker-retention anchor: this .cpp has no other referenced
// symbol, and a static archive drops object files nothing references (the same
// reason MainThreadSchedulerAndroid.cpp is force-linked). WorkerTurboModulesAndroid's
// ThreadScopeRegistrar calls this so the object file — and thus the registration —
// is actually pulled into the final binary.
void ensureExpoAndroidInstallerRegistered() {
  static const bool once = [] {
    setExpoModulesInstaller(
        [](jsi::Runtime& rt,
           std::shared_ptr<CallInvoker> invoker) -> std::function<void()> {
          return installExpoOnAndroidWorker(rt, std::move(invoker));
        });
    return true;
  }();
  (void)once;
}

} // namespace facebook::react::workers

#endif // __ANDROID__
