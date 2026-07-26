// Bridge the app's Expo AppContext (captured by the companion Swift Expo module,
// RNWorkersExpoModule) to the worker Expo-modules installer.
//
// Typed as `id` on purpose: the installer talks to the AppContext through
// informal @objc protocols (see WorkerExpoModules.mm), so it needs no
// ExpoModulesCore Swift header — which a dependent static-lib pod cannot import.
#import <Foundation/Foundation.h>

@interface RNWorkersExpoBridge : NSObject

// Called from RNWorkersExpoModule's OnCreate with the app's AppContext.
+ (void)registerAppContext:(nullable id)appContext
    NS_SWIFT_NAME(registerAppContext(_:));

@end
