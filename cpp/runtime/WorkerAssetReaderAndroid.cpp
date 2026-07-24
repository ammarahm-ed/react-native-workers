// Android implementation of WorkerAssetReader, backed by the app's AssetManager.
//
// Same lazy-factory shape as MainThreadSchedulerAndroid.cpp and for the same
// reason: library static-init runs before fbjni has a JavaVM, so we register a
// factory at static-init and build the reader on first use — which happens on
// whichever thread creates the first bundled worker (JNI-attached, so FindClass
// works).
//
// Bundles live in the APK under assets/workers/ (placed there by
// android/worker-bundles.gradle) and may be Hermes bytecode; we return raw bytes.
#if defined(__ANDROID__)

#include "WorkerAssetReader.h"

#include <fbjni/fbjni.h>

#include <memory>
#include <string>

namespace facebook::react::workers {

namespace {

constexpr const char* kBridgeClass =
    "com/ammarahmed/reactnativeworkers/WorkerAssets";

class AndroidWorkerAssetReader : public WorkerAssetReader {
 public:
  bool read(const std::string& assetName, std::string& out, std::string& error)
      override {
    // The caller may be any thread that creates a worker; attach it and use the
    // app class loader so our Kotlin class resolves.
    bool ok = false;
    facebook::jni::ThreadScope::WithClassLoader([&]() {
      try {
        auto cls = facebook::jni::findClassStatic(kBridgeClass);
        static const auto method =
            cls->getStaticMethod<facebook::jni::JArrayByte::javaobject(
                facebook::jni::JString::javaobject)>("read");

        auto bytes = method(cls, facebook::jni::make_jstring(assetName).get());
        if (!bytes) {
          error = "not found in the APK assets";
          return;
        }

        const auto size = bytes->size();
        out.resize(static_cast<size_t>(size));
        if (size > 0) {
          bytes->getRegion(0, size, reinterpret_cast<signed char*>(&out[0]));
        }
        ok = true;
      } catch (const std::exception& e) {
        error = e.what();
      } catch (...) {
        error = "unknown JNI failure";
      }
    });
    return ok;
  }
};

} // namespace

void installAndroidWorkerAssetReaderFactory() {
  setWorkerAssetReaderFactory(
      []() -> std::shared_ptr<WorkerAssetReader> {
        return std::make_shared<AndroidWorkerAssetReader>();
      });
}

} // namespace facebook::react::workers

#endif // __ANDROID__
