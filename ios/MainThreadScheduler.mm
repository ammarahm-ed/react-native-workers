#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#import "MainThreadScheduler.h"

#include <memory>

namespace facebook::react::workers {
namespace {

// MainThreadScheduler backed by the iOS main dispatch queue (the UI thread).
class IosMainScheduler : public MainThreadScheduler {
 public:
  void post(std::function<void()> fn) override {
    auto f = std::make_shared<std::function<void()>>(std::move(fn));
    dispatch_async(dispatch_get_main_queue(), ^{
      (*f)();
    });
  }
  void postDelayed(std::function<void()> fn, double ms) override {
    auto f = std::make_shared<std::function<void()>>(std::move(fn));
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ms * NSEC_PER_MSEC)),
        dispatch_get_main_queue(),
        ^{
          (*f)();
        });
  }
  bool isOnMainThread() override { return [NSThread isMainThread]; }
};

} // namespace
} // namespace facebook::react::workers

@interface RNWorkersMainThreadSchedulerLoader : NSObject
@end

@implementation RNWorkersMainThreadSchedulerLoader

+ (void)load {
  facebook::react::workers::setMainThreadScheduler(
      std::make_shared<facebook::react::workers::IosMainScheduler>());
}

@end
