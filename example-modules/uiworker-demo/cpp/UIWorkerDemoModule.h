#pragma once

#include <ReactCommon/TurboModule.h>

#include <string>

namespace uiworkerdemo {

/**
 * Platform surface for the demo. Every method here is called SYNCHRONOUSLY on
 * whatever thread the JS call came from — there is no queue hop anywhere in this
 * module — so implementations may touch UIKit/Android views directly, provided
 * the caller is on the main thread. `isOnMainThread()` is what lets JS check.
 */
class Platform {
 public:
  virtual ~Platform() = default;
  virtual bool isOnMainThread() = 0;
  virtual std::string threadName() = 0;
  virtual void showAlert(const std::string& title, const std::string& message) = 0;
  virtual void setStatusBarHidden(bool hidden) = 0;
  virtual double getBrightness() = 0;
  virtual void setBrightness(double value) = 0;
  virtual void vibrate() = 0;

  // Direct view manipulation, by React tag. Deliberately bypasses Fabric: under
  // the New Architecture a prop change is a shadow-tree mutation plus a commit,
  // owned by the HOST runtime's Fabric instance, so driving it from a second
  // runtime would be both racy and nowhere near free. Setting the platform view
  // straight is what Reanimated does for the same reason.
  //
  // The trade-off: these writes are invisible to React, so a re-render of the
  // view re-applies props from the shadow tree and overwrites them.
  virtual bool viewExists(int32_t tag) = 0;
  virtual void setViewTransform(
      int32_t tag,
      double translateX,
      double translateY,
      double scaleX,
      double scaleY,
      double rotateRadians) = 0;
  virtual void setViewOpacity(int32_t tag, double opacity) = 0;
};

// Registered once by the platform layer at load time (ios/UIWorkerDemoIOS.mm).
void setPlatform(Platform* platform);
Platform* getPlatform();

/**
 * A hand-rolled C++ TurboModule, deliberately NOT an ObjC one.
 *
 * RN's ObjC TurboModule bridge posts every void method onto the module's method
 * queue — `performVoidMethodInvocation` in RCTTurboModule.mm states outright that
 * "void methods are always async" — so an ObjC module can never be a direct call,
 * no matter which thread you invoke it from. A Cxx TurboModule has no method
 * queue: its methods run synchronously on the calling runtime's thread.
 *
 * That is the entire point of this module. Called from a UIWorker (whose runtime
 * lives on the main thread) the path is JS -> JSI -> C++ -> UIKit, with no
 * dispatch_async, no runOnUiThread, and no serialization. Called from anywhere
 * else it still runs synchronously, just not on the main thread — which is why
 * every UI-affine method checks and throws rather than corrupting UIKit state.
 */
class UIWorkerDemoModule : public facebook::react::TurboModule {
 public:
  static constexpr auto kModuleName = "UIWorkerDemo";

  explicit UIWorkerDemoModule(std::shared_ptr<facebook::react::CallInvoker> jsInvoker);

  // Registers this module in RN's global Cxx module map so that ANY runtime —
  // the host or a worker — can resolve it by name.
  static void registerSelf();
};

} // namespace uiworkerdemo
