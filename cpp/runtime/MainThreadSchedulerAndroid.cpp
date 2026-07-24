// Android implementation of MainThreadScheduler, backed by a Handler bound to
// the main (UI) Looper.
//
// Unlike iOS — where dispatch_get_main_queue() is a process-global available at
// +load — Android has no ambient main-thread dispatcher reachable from pure C++,
// and library static-init runs before fbjni is initialized (no JavaVM yet). So
// we register a *factory* at static-init (no JNI) and build the real scheduler
// lazily on first use, which happens on the JS thread when the first UIWorker is
// created (JNI-attached, so FindClass / RegisterNatives work).
//
// A posted C++ task is heap-allocated and its pointer handed to the Kotlin
// MainThreadScheduler, which posts a Runnable onto the main Handler; when that
// runs it calls back into runTask() here to execute and free the task.
#if defined(__ANDROID__)

#include "MainThreadScheduler.h"

#include <fbjni/fbjni.h>

#include <android/log.h>

#include <functional>
#include <memory>

#define RNMS_LOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerMain", __VA_ARGS__)

namespace facebook::react::workers {

namespace {

constexpr const char* kBridgeClass =
    "com/ammarahmed/reactnativeworkers/MainThreadScheduler";

// Executes a C++ task previously handed to Kotlin as an opaque pointer. Called
// on the main thread by the Handler Runnable (see MainThreadScheduler.kt).
void runTask(JNIEnv*, jclass, jlong ptr) {
  auto* fn = reinterpret_cast<std::function<void()>*>(ptr);
  if (!fn) {
    return;
  }
  // Run the task under the app class loader so any JNI FindClass it performs
  // (e.g. a UIWorker resolving app TurboModules) resolves app classes — the main
  // thread reaches here via a framework Handler Runnable, whose class loader
  // would otherwise only see framework classes.
  facebook::jni::ThreadScope::WithClassLoader([&]() {
    try {
      (*fn)();
    } catch (const std::exception& e) {
      RNMS_LOG("main-thread task threw: %s", e.what());
    } catch (...) {
      RNMS_LOG("main-thread task threw a non-std exception");
    }
  });
  delete fn;
}

class AndroidMainScheduler : public MainThreadScheduler {
 public:
  AndroidMainScheduler() {
    // Constructed on the first getMainThreadScheduler() caller — the JS thread,
    // which fbjni does not consider attached. Attach it and adopt the app class
    // loader so findClassStatic resolves our bridge class. We cache a global
    // jclass ref + method IDs here; later calls only need an attached env (the
    // cached jclass makes FindClass unnecessary), so post()/etc. use a plain
    // ThreadScope rather than WithClassLoader.
    std::string error;
    facebook::jni::ThreadScope::WithClassLoader([&]() {
      try {
        auto cls = facebook::jni::findClassStatic(kBridgeClass);
        class_ = facebook::jni::make_global(cls);
        JNIEnv* env = facebook::jni::Environment::current();

        static const JNINativeMethod methods[] = {
            {"nativeRunTask", "(J)V", reinterpret_cast<void*>(&runTask)},
        };
        if (env->RegisterNatives(class_.get(), methods, 1) != JNI_OK) {
          if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
          }
          error = "RegisterNatives failed for nativeRunTask";
          return;
        }

        postMethod_ = env->GetStaticMethodID(class_.get(), "post", "(J)V");
        postDelayedMethod_ =
            env->GetStaticMethodID(class_.get(), "postDelayed", "(JJ)V");
        isOnMainThreadMethod_ =
            env->GetStaticMethodID(class_.get(), "isOnMainThread", "()Z");
        if (!postMethod_ || !postDelayedMethod_ || !isOnMainThreadMethod_) {
          error = "bridge methods not found (RN/lib mismatch?)";
        }
      } catch (const std::exception& e) {
        error = e.what();
      }
    });
    if (!error.empty()) {
      throw std::runtime_error("MainThreadScheduler: " + error);
    }
  }

  void post(std::function<void()> fn) override {
    auto* p = new std::function<void()>(std::move(fn));
    facebook::jni::ThreadScope ts;
    JNIEnv* env = facebook::jni::Environment::current();
    env->CallStaticVoidMethod(
        class_.get(), postMethod_, reinterpret_cast<jlong>(p));
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
      delete p; // Kotlin never posted the Runnable; reclaim the task.
    }
  }

  void postDelayed(std::function<void()> fn, double ms) override {
    auto* p = new std::function<void()>(std::move(fn));
    facebook::jni::ThreadScope ts;
    JNIEnv* env = facebook::jni::Environment::current();
    env->CallStaticVoidMethod(
        class_.get(),
        postDelayedMethod_,
        reinterpret_cast<jlong>(p),
        static_cast<jlong>(ms < 0 ? 0 : ms));
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
      delete p;
    }
  }

  bool isOnMainThread() override {
    facebook::jni::ThreadScope ts;
    JNIEnv* env = facebook::jni::Environment::current();
    jboolean r =
        env->CallStaticBooleanMethod(class_.get(), isOnMainThreadMethod_);
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
      return false;
    }
    return r == JNI_TRUE;
  }

 private:
  facebook::jni::global_ref<jclass> class_;
  jmethodID postMethod_ = nullptr;
  jmethodID postDelayedMethod_ = nullptr;
  jmethodID isOnMainThreadMethod_ = nullptr;
};

} // namespace

// Registers the lazy factory (no JNI here — just stores a lambda). The scheduler
// itself is built on first use; if construction fails it returns null, leaving
// getMainThreadScheduler() to report null and the UIWorker to surface the
// standard "not available" error rather than crashing.
//
// This must be called from an already-linked translation unit
// (WorkerTurboModulesAndroid.cpp calls it): because this library is a static
// archive linked into the app's appmodules .so, a self-contained static
// initializer here would be dropped as an unreferenced object file and never
// run. The explicit call forces this TU to link and the factory to register.
void installAndroidMainThreadSchedulerFactory() {
  setMainThreadSchedulerFactory([]() -> std::shared_ptr<MainThreadScheduler> {
    try {
      return std::make_shared<AndroidMainScheduler>();
    } catch (const std::exception& e) {
      RNMS_LOG("failed to build main-thread scheduler: %s", e.what());
      return nullptr;
    }
  });
}

} // namespace facebook::react::workers

#endif // __ANDROID__
