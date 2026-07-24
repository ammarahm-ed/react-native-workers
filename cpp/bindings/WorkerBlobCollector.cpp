#include "WorkerBlobCollector.h"

// Per-worker `__blobCollectorProvider`.
//
// RN's Android implementation (ReactAndroid/.../reactnativeblob/BlobCollector.cpp)
// installs this provider onto the runtime it is handed and captures a
// `jni::global_ref<jobject>` to the Java BlobModule. Two problems in a worker:
//
//  1. `BlobModule.initialize()` passes the *host* ReactApplicationContext's JS
//     context, so a worker's BlobModule installs its provider onto the HOST
//     runtime, orphaning whatever was there before.
//  2. The captured `jni::global_ref` is released from the HostFunction's
//     destructor, which Hermes runs on its GC thread. That thread is not attached
//     to the JVM, so `DeleteGlobalRef` aborts the process.
//
// This version fixes both: it is installed onto the worker's own runtime, and the
// collector captures nothing but the blob id (a `std::string`). Freeing the blob
// goes through a static Java method, entered under a `ThreadScope` so it works no
// matter which thread finalizes the object.
#if defined(__ANDROID__)

#include <fbjni/fbjni.h>

#include <string>
#include <utility>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

constexpr const char* kBlobShimClass =
    "com/ammarahmed/reactnativeworkers/WorkerBlobModule";

// Handed to JS by `__blobCollectorProvider` and stored on the Blob object. JS
// dropping the Blob destroys this, which is our cue to free the native data.
// Holds no JNI state — that is the whole point.
class WorkerBlobCollector : public HostObject {
 public:
  explicit WorkerBlobCollector(std::string blobId) : blobId_(std::move(blobId)) {}

  ~WorkerBlobCollector() override {
    // May run on Hermes's GC thread, which is not JVM-attached.
    try {
      facebook::jni::ThreadScope::WithClassLoader([this] {
        static auto method =
            facebook::jni::findClassStatic(kBlobShimClass)
                ->getStaticMethod<void(std::string)>("releaseBlob");
        method(facebook::jni::findClassStatic(kBlobShimClass), blobId_);
      });
    } catch (const std::exception&) {
      // Teardown path: the JVM or the class may already be gone. Leaking the
      // blob is strictly better than aborting the process.
    }
  }

 private:
  std::string blobId_;
};

} // namespace

void installWorkerBlobCollector(Runtime& rt) {
  rt.global().setProperty(
      rt,
      "__blobCollectorProvider",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__blobCollectorProvider"),
          1,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 1 || !args[0].isString()) {
              return Value::undefined();
            }
            return Object::createFromHostObject(
                rt,
                std::make_shared<WorkerBlobCollector>(
                    args[0].getString(rt).utf8(rt)));
          }));
}

} // namespace facebook::react::workers

#else

namespace facebook::react::workers {
// Blob collection on iOS is installed by RCTBlobCollector against the worker's
// own runtime and captures no JNI state, so there is nothing to replace.
void installWorkerBlobCollector(facebook::jsi::Runtime&) {}
} // namespace facebook::react::workers

#endif // __ANDROID__
