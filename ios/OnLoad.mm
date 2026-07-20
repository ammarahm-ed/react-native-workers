#import <Foundation/Foundation.h>
#import "ReactNativeWorkersImpl.h"
#import <ReactCommon/CxxTurboModuleUtils.h>

@interface ReactNativeWorkersOnLoad : NSObject
@end

@implementation ReactNativeWorkersOnLoad

using namespace facebook::react;

+ (void)load
{
  registerCxxModuleToGlobalModuleMap(
    std::string(ReactNativeWorkersImpl::kModuleName),
    [](std::shared_ptr<CallInvoker> jsInvoker) {
      return std::make_shared<ReactNativeWorkersImpl>(jsInvoker);
    }
  );
}

@end
