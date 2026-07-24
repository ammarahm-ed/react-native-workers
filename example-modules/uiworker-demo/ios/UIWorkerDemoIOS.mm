#import <AudioToolbox/AudioToolbox.h>
#import <UIKit/UIKit.h>

#include "UIWorkerDemoModule.h"

#include <string>

namespace {

// Straight UIKit calls. No dispatch_get_main_queue, no RCTExecuteOnMainQueue:
// the C++ layer has already established that we are on the main thread, so these
// are the same calls a view controller would make inline.
class IosPlatform : public uiworkerdemo::Platform {
 public:
  bool isOnMainThread() override {
    return NSThread.isMainThread;
  }

  std::string threadName() override {
    NSThread *t = NSThread.currentThread;
    NSString *name = t.name.length > 0 ? t.name : (t.isMainThread ? @"main" : @"background");
    return std::string([[NSString stringWithFormat:@"%@ (%p)", name, t] UTF8String]);
  }

  void showAlert(const std::string &title, const std::string &message) override {
    UIViewController *root = topViewController();
    if (!root) return;
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:toNSString(title)
                                            message:toNSString(message)
                                     preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK"
                                              style:UIAlertActionStyleDefault
                                            handler:nil]];
    [root presentViewController:alert animated:YES completion:nil];
  }

  void setStatusBarHidden(bool hidden) override {
    // Deprecated on iOS 13+ but still the one-liner that visibly proves a direct
    // UIKit mutation happened; a real app would drive this from a view
    // controller's prefersStatusBarHidden.
    UIApplication.sharedApplication.statusBarHidden = hidden;
  }

  double getBrightness() override {
    return UIScreen.mainScreen.brightness;
  }

  void setBrightness(double value) override {
    UIScreen.mainScreen.brightness = MAX(0.0, MIN(1.0, value));
  }

  void vibrate() override {
    AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
  }

  bool viewExists(int32_t tag) override {
    return lookup(tag) != nil;
  }

  void setViewTransform(
      int32_t tag,
      double translateX,
      double translateY,
      double scaleX,
      double scaleY,
      double rotateRadians) override {
    UIView *view = lookup(tag);
    if (!view) return;
    // Compose straight into a CGAffineTransform and assign: no prop parsing, no
    // layout pass, no Fabric commit. Exactly what a view controller would do.
    CGAffineTransform t = CGAffineTransformMakeTranslation(translateX, translateY);
    if (rotateRadians != 0) t = CGAffineTransformRotate(t, rotateRadians);
    if (scaleX != 1 || scaleY != 1) t = CGAffineTransformScale(t, scaleX, scaleY);
    view.transform = t;
  }

  void setViewOpacity(int32_t tag, double opacity) override {
    UIView *view = lookup(tag);
    if (!view) return;
    view.alpha = opacity;
  }

 private:
  // An animation calls these ~60x/second for the same tag, so cache the last
  // resolution instead of walking the window hierarchy every frame. Held weakly:
  // the view must not be kept alive by us after React unmounts it.
  __weak UIView *cachedView_ = nil;
  int32_t cachedTag_ = 0;

  UIView *lookup(int32_t tag) {
    UIView *cached = cachedView_;
    if (cached != nil && cachedTag_ == tag && cached.window != nil) {
      return cached;
    }
    // Fabric assigns the React tag to UIView.tag when it creates a component
    // view, so UIKit's own -viewWithTag: finds it. No RCTSurfacePresenter and no
    // private headers, which is what keeps this stable across RN versions.
    UIView *found = findViewWithTag(static_cast<NSInteger>(tag));
    cachedView_ = found;
    cachedTag_ = tag;
    return found;
  }

  static UIView *findViewWithTag(NSInteger tag) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:UIWindowScene.class]) continue;
      for (UIWindow *window in ((UIWindowScene *)scene).windows) {
        UIView *found = [window viewWithTag:tag];
        if (found) return found;
      }
    }
    return nil;
  }

  static NSString *toNSString(const std::string &s) {
    return [NSString stringWithUTF8String:s.c_str()] ?: @"";
  }

  static UIViewController *topViewController() {
    UIWindow *keyWindow = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:UIWindowScene.class]) continue;
      for (UIWindow *window in ((UIWindowScene *)scene).windows) {
        if (window.isKeyWindow) {
          keyWindow = window;
          break;
        }
      }
    }
    UIViewController *vc = keyWindow.rootViewController;
    while (vc.presentedViewController) {
      vc = vc.presentedViewController;
    }
    return vc;
  }
};

IosPlatform gPlatform;

} // namespace

@interface UIWorkerDemoLoader : NSObject
@end

@implementation UIWorkerDemoLoader

+ (void)load {
  uiworkerdemo::setPlatform(&gPlatform);
  // Register in RN's global Cxx module map so every runtime — the host and any
  // worker created later — can resolve "UIWorkerDemo" by name.
  uiworkerdemo::UIWorkerDemoModule::registerSelf();
}

@end
