#import <Foundation/Foundation.h>

#import <ReactCommon/CxxTurboModuleUtils.h>
#import <react/nativemodule/defaults/DefaultTurboModules.h>
#import <ReactCommon/RCTTurboModuleManager.h>
#import <ReactCommon/RCTTurboModule.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTBridgeModuleDecorator.h>
#import <ReactCommon/TurboModule.h>
#import <ReactCommon/TurboModuleBinding.h>

#import "WorkerTurboModules.h"

#include <functional>
#include <memory>
#include <string>

using facebook::react::CallInvoker;
using facebook::react::TurboModule;

// A self-contained delegate. Returning nil from the class-resolution methods
// makes RCTTurboModuleManager fall back to the process-global RCT_EXPORT_MODULE
// registry (RCTGetModuleClasses / NSClassFromString), so ANY registered ObjC
// module resolves by name — no app cooperation required. C++ (Cxx) modules are
// resolved from the global exported map (incl. this library's own module), and
// codegen'd modules from the generated RCTModuleProviders table.
@interface RNWorkersTMDelegate : NSObject <RCTTurboModuleManagerDelegate> {
@public
  std::shared_ptr<CallInvoker> _invoker;
}
@end

@implementation RNWorkersTMDelegate

- (std::shared_ptr<TurboModule>)getTurboModule:(const std::string &)name
                                     jsInvoker:(std::shared_ptr<CallInvoker>)jsInvoker
{
  if (facebook::react::workers::isWorkerModuleDenied(name)) {
    return nullptr;
  }
  auto &cxxMap = facebook::react::globalExportedCxxTurboModuleMap();
  auto it = cxxMap.find(name);
  if (it != cxxMap.end()) {
    return it->second(jsInvoker);
  }
  // RN's own built-in C++ modules (NativeMicrotasks, NativeReactNativeFeatureFlags,
  // NativeDOM, …) are not in the global exported map — they come from this
  // provider, which the host consults via RCTAppDelegate. Without it, importing
  // almost any library inside a worker fails on `NativeMicrotasksCxx`.
  if (auto defaultModule = facebook::react::DefaultTurboModules::getTurboModule(name, jsInvoker)) {
    return defaultModule;
  }
  // ObjC modules are resolved via the class-name fallback below.
  return nullptr;
}

- (Class)getModuleClassFromName:(const char *)name
{
  if (facebook::react::workers::isWorkerModuleDenied(std::string(name))) {
    return nil;
  }
  // nil -> RCTTurboModuleManager consults RCTGetModuleClasses() / NSClassFromString.
  return nil;
}

- (id<RCTTurboModule>)getModuleInstanceFromClass:(Class)moduleClass
{
  // nil -> RCTTurboModuleManager does [moduleClass new].
  return nil;
}

- (id<RCTModuleProvider>)getModuleProvider:(const char *)name
{
  if (facebook::react::workers::isWorkerModuleDenied(std::string(name))) {
    return nil;
  }
  // A codegen'd module (RN 0.79+) with a `modulesProvider` entry is registered in
  // neither the RCT_EXPORT_MODULE class registry nor the global Cxx map — it lives
  // in the generated `RCTModuleProviders` table, and RCTTurboModuleManager reaches
  // it ONLY through this delegate method (RCTTurboModuleManager.mm
  // `_moduleProviderForName:`). Without this, every such module — the whole
  // C++-TurboModule-behind-an-ObjC-provider shape, e.g. @nativescript/react-native
  // — is invisible inside a worker and `getEnforcing()` throws.
  //
  // Read the table by name so no app cooperation is required, mirroring the
  // RCTGetModuleClasses fallback used for ObjC modules above. The generated
  // `+moduleProviders` is a process-wide dispatch_once dictionary of stateless
  // factories; the TurboModule itself is built per-manager from OUR jsInvoker, so
  // each worker still gets its own instance bound to its own runtime.
  static NSDictionary<NSString *, id<RCTModuleProvider>> *providers = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Class cls = NSClassFromString(@"RCTModuleProviders");
    SEL sel = NSSelectorFromString(@"moduleProviders");
    if (cls != Nil && [cls respondsToSelector:sel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      providers = [cls performSelector:sel];
#pragma clang diagnostic pop
    }
  });
  return providers[[NSString stringWithUTF8String:name]];
}

@end

namespace facebook::react::workers {

namespace {
// Lightweight Cxx-only binding (nested workers + C++ modules), used when the
// worker doesn't opt into platform modules. Nothing to tear down (dies with the
// runtime).
void installCxxOnly(jsi::Runtime &rt, std::shared_ptr<CallInvoker> workerInvoker)
{
  TurboModuleBinding::install(
      rt,
      [workerInvoker](jsi::Runtime &, const std::string &name)
          -> std::shared_ptr<TurboModule> {
        if (isWorkerModuleDenied(name)) {
          return nullptr;
        }
        auto &cxxMap = globalExportedCxxTurboModuleMap();
        auto it = cxxMap.find(name);
        if (it != cxxMap.end()) {
          return it->second(workerInvoker);
        }
        return DefaultTurboModules::getTurboModule(name, workerInvoker);
      });
}
} // namespace

std::function<void(jsi::Runtime &)> installWorkerTurboModules(
    jsi::Runtime &rt,
    std::shared_ptr<CallInvoker> workerInvoker,
    bool nativeModules)
{
  rt.global().setProperty(rt, "RN$Bridgeless", jsi::Value(true));

  if (!nativeModules) {
    installCxxOnly(rt, std::move(workerInvoker));
    return {};
  }

  RNWorkersTMDelegate *delegate = [RNWorkersTMDelegate new];
  delegate->_invoker = workerInvoker;

  // ObjC modules built by this manager are RCTBridgeModules: RCTEventEmitter
  // subclasses (WebSocketModule, AppState, Linking, …) call into JS through
  // `callableJSModules`. Constructed with a nil bridge they have none, and the
  // first `sendEventWithName:` aborts the process on an assertion — which is what
  // happens as soon as a worker imports a library that touches one.
  //
  // So give them an invoker that routes into THIS worker's runtime. Device events
  // land on the worker's own `global.__rctDeviceEventEmitter` (installed by the
  // worker prelude), which is the same path host-originated events already use.
  RCTCallableJSModules *callableJSModules = [RCTCallableJSModules new];
  std::weak_ptr<CallInvoker> weakInvoker = workerInvoker;
  [callableJSModules
      setBridgelessJSModuleMethodInvoker:^(
          NSString *moduleName, NSString *methodName, NSArray *args, dispatch_block_t onComplete) {
        auto invoker = weakInvoker.lock();
        if (!invoker) {
          return;
        }
        NSString *module = [moduleName copy];
        NSString *method = [methodName copy];
        NSArray *callArgs = [args copy];
        invoker->invokeAsync([module, method, callArgs](jsi::Runtime &rt) {
          // Only the device-event emitter is meaningful in a worker; other
          // callable JS modules (e.g. HMRClient) have no counterpart there.
          if (![module isEqualToString:@"RCTDeviceEventEmitter"]) {
            return;
          }
          auto emitterVal = rt.global().getProperty(rt, "__rctDeviceEventEmitter");
          if (!emitterVal.isObject()) {
            return;
          }
          auto emitter = emitterVal.asObject(rt);
          auto fnVal = emitter.getProperty(rt, jsi::PropNameID::forUtf8(rt, [method UTF8String]));
          if (!fnVal.isObject() || !fnVal.asObject(rt).isFunction(rt)) {
            return;
          }
          std::vector<jsi::Value> jsArgs;
          jsArgs.reserve(callArgs.count);
          for (id arg in callArgs) {
            jsArgs.emplace_back(TurboModuleConvertUtils::convertObjCObjectToJSIValue(rt, arg));
          }
          // Must be a METHOD call. RN's RCTDeviceEventEmitterImpl keeps its
          // listener registry in a Babel loose-mode private field, so invoking
          // `emit` with an undefined receiver throws "attempted to use private
          // field on non-instance" (RN's own emitDeviceEvent uses callWithThis
          // for the same reason).
          fnVal.asObject(rt).asFunction(rt).callWithThis(
              rt, emitter, static_cast<const jsi::Value *>(jsArgs.data()), jsArgs.size());
        });
        if (onComplete) {
          onComplete();
        }
      }];

  RCTBridgeModuleDecorator *decorator =
      [[RCTBridgeModuleDecorator alloc] initWithViewRegistry:nil
                                             moduleRegistry:nil
                                              bundleManager:nil
                                          callableJSModules:callableJSModules];

  RCTTurboModuleManager *manager =
      [[RCTTurboModuleManager alloc] initWithBridgeProxy:nil
                                  bridgeModuleDecorator:decorator
                                               delegate:delegate
                                              jsInvoker:workerInvoker];
  [manager installJSBindings:rt];

  // Cleanup: invalidate on the worker thread WHILE the runtime is still alive, so
  // the worker's Cxx-module jsi::WeakObjects (e.g. the ReactNativeWorkers module
  // used for nested workers) tear down against a valid runtime. `_invalidateModules`
  // runs `_moduleHolders.clear()` synchronously on the calling thread, so this is
  // safe here. Capturing `manager`/`delegate` keeps them alive for the worker's
  // lifetime (ARC); they're released when this callback is destroyed, just after
  // it runs — before the runtime is destroyed.
  return [manager, delegate](jsi::Runtime &) {
    (void)delegate;
    [manager invalidate];
  };
}

} // namespace facebook::react::workers
