#import <Foundation/Foundation.h>

#import <ReactCommon/CxxTurboModuleUtils.h>
#import <react/nativemodule/defaults/DefaultTurboModules.h>
#import <ReactCommon/RCTTurboModuleManager.h>
#import <ReactCommon/RCTTurboModule.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTBridgeModuleDecorator.h>
#import <React/RCTBundleAssetImageLoader.h>
#import <React/RCTDataRequestHandler.h>
#import <React/RCTFileRequestHandler.h>
#import <React/RCTGIFImageDecoder.h>
#import <React/RCTHTTPRequestHandler.h>
#import <React/RCTImageLoader.h>
#import <React/RCTNetworking.h> // RCTModuleRegistry is declared in RCTBridgeModule.h
#import <ReactCommon/TurboModule.h>
#import <ReactCommon/TurboModuleBinding.h>

#import "WorkerTurboModules.h"
#import "../cpp/bindings/WorkerTurboModuleCompat.h"

#include <functional>
#include <memory>
#include <string>

using facebook::react::CallInvoker;
using facebook::react::TurboModule;

// --- host-injected module dependencies --------------------------------------
//
// Two RN modules cannot be built by `[moduleClass new]`: RCTNetworking and
// RCTImageLoader both take their dependency lists through initializer-injected
// provider blocks, falling back to `self.bridge` — and bridgeless has no bridge.
// The host app never notices because RCTAppSetupUtils injects them on its behalf.
// A worker that builds them plainly gets EMPTY lists: no URL handlers (every
// request fails with "No suitable URL request handler found"), no image loaders
// and no decoders. See `getModuleInstanceFromClass:` below, which mirrors
// RCTAppSetupUtils for both.

// The autolinked class names for one of the dependency lists.
//
// The app's `RCTAppDependencyProvider` is code-generated at install time, so it is
// reached reflectively (as with `RCTModuleProviders` below) rather than linked
// against — a worker must work in apps that have no such class at all.
static NSArray<NSString *> *RNWorkersDependencyClassNames(NSString *selectorName)
{
  static NSMutableDictionary<NSString *, NSArray<NSString *> *> *cache = nil;
  static id provider = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    cache = [NSMutableDictionary new];
    Class cls = NSClassFromString(@"RCTAppDependencyProvider");
    if (cls != Nil) {
      provider = [cls new];
    }
  });
  @synchronized(cache) {
    NSArray<NSString *> *cached = cache[selectorName];
    if (cached != nil) {
      return cached;
    }
    NSArray<NSString *> *names = nil;
    SEL sel = NSSelectorFromString(selectorName);
    if (provider != nil && [provider respondsToSelector:sel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      names = [provider performSelector:sel];
#pragma clang diagnostic pop
    }
    if (names == nil) {
      names = @[];
    }
    cache[selectorName] = names;
    return names;
  }
}

// The autolinked modules for one dependency list, resolved from THIS WORKER's
// registry. Non-conforming entries are skipped, as RN does — a name in the
// generated list is not a guarantee of protocol conformance.
static NSArray *RNWorkersModulesConformingTo(
    RCTModuleRegistry *moduleRegistry,
    NSString *selectorName,
    Protocol *protocol)
{
  NSMutableArray *modules = [NSMutableArray new];
  for (NSString *className in RNWorkersDependencyClassNames(selectorName)) {
    id module = [moduleRegistry moduleForName:[className UTF8String]];
    if (module != nil && [module conformsToProtocol:protocol]) {
      [modules addObject:module];
    }
  }
  return modules;
}

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
  // The two modules whose dependencies the HOST injects — mirror RN's own lists
  // (RCTAppSetupUtils.mm), resolved from the WORKER's module registry so every
  // dependency is this worker's instance rather than the host's. See the note at
  // the top of this file for why `[moduleClass new]` is wrong for these.
  if (moduleClass == RCTNetworking.class) {
    return [[moduleClass alloc]
        initWithHandlersProvider:^NSArray<id<RCTURLRequestHandler>> *(RCTModuleRegistry *moduleRegistry) {
          NSMutableArray<id<RCTURLRequestHandler>> *handlers = [NSMutableArray arrayWithObjects:[RCTHTTPRequestHandler new],
                                                                                               [RCTDataRequestHandler new],
                                                                                               [RCTFileRequestHandler new],
                                                                                               nil];
          // blob: URLs. Same lookup RN does; nil when the worker denies BlobModule.
          id blobModule = [moduleRegistry moduleForName:"BlobModule"];
          if (blobModule != nil) {
            [handlers addObject:(id<RCTURLRequestHandler>)blobModule];
          }
          [handlers addObjectsFromArray:RNWorkersModulesConformingTo(
                                            moduleRegistry,
                                            @"URLRequestHandlerClassNames",
                                            @protocol(RCTURLRequestHandler))];
          return handlers;
        }];
  }
  if (moduleClass == RCTImageLoader.class) {
    return [[moduleClass alloc]
        initWithRedirectDelegate:nil
        loadersProvider:^NSArray<id<RCTImageURLLoader>> *(RCTModuleRegistry *moduleRegistry) {
          NSMutableArray<id<RCTImageURLLoader>> *loaders =
              [NSMutableArray arrayWithObject:[RCTBundleAssetImageLoader new]];
          [loaders addObjectsFromArray:RNWorkersModulesConformingTo(
                                           moduleRegistry,
                                           @"imageURLLoaderClassNames",
                                           @protocol(RCTImageURLLoader))];
          return loaders;
        }
        decodersProvider:^NSArray<id<RCTImageDataDecoder>> *(RCTModuleRegistry *moduleRegistry) {
          NSMutableArray<id<RCTImageDataDecoder>> *decoders =
              [NSMutableArray arrayWithObject:[RCTGIFImageDecoder new]];
          [decoders addObjectsFromArray:RNWorkersModulesConformingTo(
                                            moduleRegistry,
                                            @"imageDataDecoderClassNames",
                                            @protocol(RCTImageDataDecoder))];
          return decoders;
        }];
  }
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
  installWorkerTurboModuleBinding(
      rt,
      [workerInvoker](const std::string &name) -> std::shared_ptr<TurboModule> {
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

  // Peer module lookup, worker-local.
  //
  // `@synthesize moduleRegistry` and `[_moduleRegistry moduleForName:"…"]` is the
  // bridgeless way for a native module to reach another one, and it is common in
  // third-party libraries. Passed nil here, every such lookup returned nil inside
  // a worker and the module silently degraded — RCTImageLoader is the first-party
  // proof: it asks the registry for "Networking", got nil, and reported "No
  // suitable image URL loader found … import the RCTNetwork library".
  //
  // Point it at THIS worker's TurboModuleManager (which conforms to
  // RCTTurboModuleRegistry), so a peer resolves to the worker's own instance and
  // never to the host's — the iOS counterpart of the Android worker-local peer
  // resolution. The registry holds the manager weakly, and the manager is kept
  // alive by the teardown callback below.
  RCTModuleRegistry *moduleRegistry = [RCTModuleRegistry new];

  RCTBridgeModuleDecorator *decorator =
      [[RCTBridgeModuleDecorator alloc] initWithViewRegistry:nil
                                             moduleRegistry:moduleRegistry
                                              bundleManager:nil
                                          callableJSModules:callableJSModules];

  // RN 0.87 REMOVED the 4-argument initializer and kept only the variant that
  // also takes a dev-menu configuration decorator (0.86 ships both). Same
  // tolerance idea as WorkerTurboModuleCompat.h's provider-arity branch: gate on
  // the version so every already-supported RN keeps the exact call it had.
  // A worker has no dev menu, so the decorator is nil.
#if defined(REACT_NATIVE_VERSION_MINOR) && \
    (REACT_NATIVE_VERSION_MAJOR > 0 || REACT_NATIVE_VERSION_MINOR >= 87)
  RCTTurboModuleManager *manager =
      [[RCTTurboModuleManager alloc] initWithBridgeProxy:nil
                                  bridgeModuleDecorator:decorator
                                               delegate:delegate
                                              jsInvoker:workerInvoker
                          devMenuConfigurationDecorator:nil];
#else
  RCTTurboModuleManager *manager =
      [[RCTTurboModuleManager alloc] initWithBridgeProxy:nil
                                  bridgeModuleDecorator:decorator
                                               delegate:delegate
                                              jsInvoker:workerInvoker];
#endif
  // Close the cycle: modules built by this manager now resolve their peers through
  // it. Set after construction because the manager does not exist any earlier.
  [moduleRegistry setTurboModuleRegistry:manager];
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
