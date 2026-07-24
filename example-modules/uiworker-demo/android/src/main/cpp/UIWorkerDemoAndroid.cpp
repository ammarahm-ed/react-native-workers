#include <fbjni/fbjni.h>
#include <sys/prctl.h>
#include <unistd.h>

#include "UIWorkerDemoModule.h"

#include <string>

namespace {

using namespace facebook;

/**
 * Thin fbjni binding to the Kotlin side. Every method here is a DIRECT static
 * call on the calling thread — no runOnUiThread, no queue — which is only legal
 * because the shared C++ layer has already checked we are on the main thread.
 *
 * The UI work lives in Kotlin rather than in raw JNI because reaching Android's
 * window/vibrator/view APIs from C++ would be several times the code for no
 * benefit: the call is synchronous either way.
 */
struct JPlatform : jni::JavaClass<JPlatform> {
  static constexpr auto kJavaDescriptor = "Lcom/uiworkerdemo/UIWorkerDemoPlatform;";

  static void showAlert(const std::string& title, const std::string& message) {
    static const auto method =
        javaClassStatic()
            ->getStaticMethod<void(jni::alias_ref<jni::JString>, jni::alias_ref<jni::JString>)>(
                "showAlert");
    method(javaClassStatic(), jni::make_jstring(title), jni::make_jstring(message));
  }

  static void setStatusBarHidden(bool hidden) {
    static const auto method =
        javaClassStatic()->getStaticMethod<void(jboolean)>("setStatusBarHidden");
    method(javaClassStatic(), static_cast<jboolean>(hidden));
  }

  static double getBrightness() {
    static const auto method = javaClassStatic()->getStaticMethod<jdouble()>("getBrightness");
    return method(javaClassStatic());
  }

  static void setBrightness(double value) {
    static const auto method = javaClassStatic()->getStaticMethod<void(jdouble)>("setBrightness");
    method(javaClassStatic(), value);
  }

  static void vibrate() {
    static const auto method = javaClassStatic()->getStaticMethod<void()>("vibrate");
    method(javaClassStatic());
  }

  static bool viewExists(int32_t tag) {
    static const auto method = javaClassStatic()->getStaticMethod<jboolean(jint)>("viewExists");
    return method(javaClassStatic(), static_cast<jint>(tag)) == JNI_TRUE;
  }

  static void setViewTransform(
      int32_t tag,
      double translateX,
      double translateY,
      double scaleX,
      double scaleY,
      double rotateRadians) {
    static const auto method =
        javaClassStatic()
            ->getStaticMethod<void(jint, jdouble, jdouble, jdouble, jdouble, jdouble)>(
                "setViewTransform");
    method(
        javaClassStatic(),
        static_cast<jint>(tag),
        translateX,
        translateY,
        scaleX,
        scaleY,
        rotateRadians);
  }

  static void setViewOpacity(int32_t tag, double opacity) {
    static const auto method =
        javaClassStatic()->getStaticMethod<void(jint, jdouble)>("setViewOpacity");
    method(javaClassStatic(), static_cast<jint>(tag), opacity);
  }
};

class AndroidPlatform : public uiworkerdemo::Platform {
 public:
  bool isOnMainThread() override {
    // Deliberately NOT a JNI call to Looper. This runs on every UI-affine method
    // — including ~60x/second from the animation — and a background Worker must
    // be able to ask without touching the JVM at all. On Linux/Android the
    // process's initial thread IS the UI thread, and only that thread has
    // gettid() == getpid().
    return gettid() == getpid();
  }

  std::string threadName() override {
    // prctl rather than pthread_getname_np: the latter is API 26+, and this
    // module supports 24. PR_GET_NAME always reports the CALLING thread, which
    // is what we want, and needs a buffer of at least 16 bytes.
    char buf[32] = {0};
    if (prctl(PR_GET_NAME, reinterpret_cast<unsigned long>(buf), 0, 0, 0) != 0) {
      buf[0] = '\0';
    }
    std::string name = buf[0] != '\0' ? buf : (isOnMainThread() ? "main" : "background");
    return name + " (tid " + std::to_string(gettid()) + ")";
  }

  void showAlert(const std::string& title, const std::string& message) override {
    JPlatform::showAlert(title, message);
  }
  void setStatusBarHidden(bool hidden) override {
    JPlatform::setStatusBarHidden(hidden);
  }
  double getBrightness() override {
    return JPlatform::getBrightness();
  }
  void setBrightness(double value) override {
    JPlatform::setBrightness(value);
  }
  void vibrate() override {
    JPlatform::vibrate();
  }
  bool viewExists(int32_t tag) override {
    return JPlatform::viewExists(tag);
  }
  void setViewTransform(
      int32_t tag,
      double translateX,
      double translateY,
      double scaleX,
      double scaleY,
      double rotateRadians) override {
    JPlatform::setViewTransform(tag, translateX, translateY, scaleX, scaleY, rotateRadians);
  }
  void setViewOpacity(int32_t tag, double opacity) override {
    JPlatform::setViewOpacity(tag, opacity);
  }
};

AndroidPlatform gPlatform;

} // namespace

// The Android counterpart of `+load` in UIWorkerDemoIOS.mm. Kotlin's
// UIWorkerDemoPackage triggers this by loading the library, which happens while
// React Native builds its package list — before any worker can exist.
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] {
    uiworkerdemo::setPlatform(&gPlatform);
    // Register in RN's global Cxx module map so every runtime — the host and any
    // worker created later — can resolve "UIWorkerDemo" by name.
    uiworkerdemo::UIWorkerDemoModule::registerSelf();
  });
}
