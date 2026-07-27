// Install the Expo Modules API (`global.expo` + `requireNativeModule`) into a
// WORKER runtime on iOS — without ever crossing runtimes.
//
// Expo's own `ExpoModulesHostObject` builds each module's JS object against the
// AppContext's bound (MAIN) runtime, so accessing it from a worker runtime
// crashes. Instead we install OUR OWN host object, created in the WORKER runtime,
// that forwards every call to the native side through PUBLIC @objc AppContext APIs:
//
//   * constants   → `AppContext.expoModulesConfig` (EXModulesProxyConfig) →
//                    toDictionary[@"modulesConstants"][module]
//   * functions   → `AppContext.callFunction:onModule:withArgs:resolve:reject:`
//                    (native [Any] in, native result out — no JS-object building)
//
// All jsi<->native marshalling happens on the worker thread against the worker
// runtime; the native call goes through Expo's registry with native values. The
// async result is delivered back on the worker thread via the worker CallInvoker.
//
// Compiles to nothing unless ExpoModulesCore's headers are visible (Expo apps).
// The app's AppContext is captured by the companion Swift module (RNWorkersExpoModule).

#import <Foundation/Foundation.h>

// Outside the availability guard: RNWorkersExpoBridge is implemented at the
// bottom of this file on every SDK (see the note there).
#import "RNWorkersExpoBridge.h"

// Where Expo keeps its ObjC JSI headers moved in SDK 55: `ExpoModulesCore.podspec`
// gained `exclude_files: ['ios/JSI', …]` and a sibling `ExpoModulesJSI` pod took
// them over with `header_dir = 'ExpoModulesJSI'`. Same classes, same API — only
// the umbrella changed. So probe both umbrellas instead of hard-coding one:
//
//   SDK 54  -> <ExpoModulesCore/EXJavaScript*.h>
//   SDK 55  -> <ExpoModulesJSI/EXJavaScript*.h>
//   SDK 56+ -> neither; the ObjC classes were rewritten in Swift (see below)
//
// EXJSIInstaller.h and EventEmitter.h live in `ios/JS` and `common/cpp`, which
// ExpoModulesCore still owns on every SDK, so they are imported unconditionally.
#if __has_include(<ExpoModulesCore/EXJavaScriptRuntime.h>)
#define RNWORKERS_EXPO_JSI_IN_CORE 1
#elif __has_include(<ExpoModulesJSI/EXJavaScriptRuntime.h>)
#define RNWORKERS_EXPO_JSI_IN_JSI_POD 1
#endif

#if __has_include(<ExpoModulesCore/EXJSIInstaller.h>) && \
    (defined(RNWORKERS_EXPO_JSI_IN_CORE) || defined(RNWORKERS_EXPO_JSI_IN_JSI_POD))

#define RNWORKERS_HAS_EXPO_MODULES 1

#import <ReactCommon/CallInvoker.h>
#import <jsi/jsi.h>

#include <optional>

// Public ObjC JSI headers (Expo apps only). These let us touch the MAIN runtime
// and a module's main-runtime JS object without importing Expo's Swift-generated
// header and without @testable — used only for the event bridge and live props.
#ifdef RNWORKERS_EXPO_JSI_IN_CORE
#import <ExpoModulesCore/EXJavaScriptRuntime.h>
#import <ExpoModulesCore/EXJavaScriptObject.h>
#import <ExpoModulesCore/EXJavaScriptValue.h>
#import <ExpoModulesCore/EXJSIConversions.h>
#import <ExpoModulesCore/EXJSIUtils.h>
#import <ExpoModulesCore/JSIUtils.h>
#else
#import <ExpoModulesJSI/EXJavaScriptRuntime.h>
#import <ExpoModulesJSI/EXJavaScriptObject.h>
#import <ExpoModulesJSI/EXJavaScriptValue.h>
#import <ExpoModulesJSI/EXJSIConversions.h>
#import <ExpoModulesJSI/EXJSIUtils.h>
#import <ExpoModulesJSI/JSIUtils.h>
#endif
#import <ExpoModulesCore/EventEmitter.h>

#import <atomic>
#import <chrono>
#import <condition_variable>
#import <memory>
#import <mutex>
#import <string>
#import <unordered_map>
#import <vector>

#import "RNWorkersExpoBridge.h"
#import "../cpp/bindings/WorkerExpoModules.h"

namespace jsi = facebook::jsi;
using facebook::react::CallInvoker;

// ---------------------------------------------------------------------------
// Informal protocols: call Expo's @objc Swift APIs without importing its
// (dependent-inaccessible) Swift-generated header. Dispatch is by selector.
// ---------------------------------------------------------------------------
@protocol RNWExpoConfig <NSObject>
- (NSDictionary *)toDictionary;
@end

@protocol RNWExpoAppContext <NSObject>
- (id<RNWExpoConfig>)expoModulesConfig;
- (BOOL)hasModule:(NSString *)name;
- (NSArray<NSString *> *)getModuleNames;
- (void)callFunction:(NSString *)functionName
            onModule:(NSString *)moduleName
            withArgs:(NSArray *)args
             resolve:(void (^)(id))resolve
              reject:(void (^)(NSString *, NSString *, NSError *))reject;
// @objc AppContext members used for the event bridge + live properties. `_runtime`
// is `@objc public var _runtime: ExpoRuntime?` (ExpoRuntime is @objc(EXRuntime),
// a subclass of EXJavaScriptRuntime); `getNativeModuleObject:` returns the module's
// JS object built against the MAIN runtime — only ever touched on the main thread.
- (EXJavaScriptRuntime *)_runtime;
- (EXJavaScriptObject *)getNativeModuleObject:(NSString *)moduleName;
@end

// The AppContext, captured by the companion Expo module (weak — a host reload
// tears it down).
// Informal protocol for the Swift factory — same reason as RNWExpoAppContext: no
// Swift-generated header, which a dependent static-lib pod cannot import.
@protocol RNWExpoWorkerContext <NSObject>
+ (nullable id)createWithRuntime:(nonnull id)runtime;
- (BOOL)hasModules;
- (void)invalidate;
@end

static __weak id<RNWExpoAppContext> gAppContext = nil;

namespace {

// ---- jsi <-> native marshalling ----
// Reuse ExpoModulesCore's own conversions (<ExpoModulesCore/EXJSIConversions.h>)
// rather than reimplementing them. They cover null/bool/number/string/array/object
// and — crucially — ArrayBuffer & typed arrays <-> Uint8Array, so binary crosses
// exactly the way it does for a first-class Expo module. Same code Expo runs when
// marshalling a module's arguments and results; we just point it at the worker (or
// main) runtime as appropriate.
//
// `convertJSIValueToObjCObject` takes a CallInvoker only to wrap a JS *function*
// argument as a native callback (irrelevant for the plain data we pass), so we
// always hand it the caller's invoker.
inline id idFromJsi(
    jsi::Runtime &rt,
    const jsi::Value &v,
    const std::shared_ptr<CallInvoker> &invoker) {
  return expo::convertJSIValueToObjCObject(rt, v, invoker);
}

inline jsi::Value jsiFromId(jsi::Runtime &rt, id value) {
  return expo::convertObjCObjectToJSIValue(rt, value);
}

// Invoke `module.fn(...)` natively. Sync Expo `Function`s fire the callback
// inline (during callFunction) — we detect that and return the value DIRECTLY
// (no Promise). AsyncFunctions fire later — we return a Promise settled on the
// worker thread. One code path, decided by whether the callback fired before
// callFunction returned; a mutex serializes the two sides.
jsi::Value callExpoFunction(
    jsi::Runtime &rt,
    NSString *moduleName,
    NSString *fnName,
    const std::shared_ptr<CallInvoker> &invoker,
    const jsi::Value *args,
    size_t count) {
  id<RNWExpoAppContext> ctx = gAppContext;
  if (!ctx) {
    return jsi::Value::undefined();
  }
  NSMutableArray *nargs = [NSMutableArray arrayWithCapacity:count];
  for (size_t i = 0; i < count; i++) {
    [nargs addObject:idFromJsi(rt, args[i], invoker)];
  }

  struct Settle {
    std::mutex m;
    bool done = false;
    bool ok = false;
    id result = nil;
    NSString *code = nil;
    NSString *msg = nil;
    std::shared_ptr<jsi::Function> jsResolve; // set only for the async path
    std::shared_ptr<jsi::Function> jsReject;
    std::shared_ptr<CallInvoker> invoker;
  };
  auto s = std::make_shared<Settle>();
  s->invoker = invoker;

  // Settle the (already-created) Promise on the worker thread. Caller holds s->m.
  auto settle = [](std::shared_ptr<Settle> s) {
    if (!s->jsResolve || !s->jsReject) {
      return;
    }
    if (s->ok) {
      auto res = s->result;
      auto fn = s->jsResolve;
      s->invoker->invokeAsync([fn, res](jsi::Runtime &rt) {
        try {
          fn->call(rt, jsiFromId(rt, res));
        } catch (...) {
        }
      });
    } else {
      auto fn = s->jsReject;
      NSString *msg = s->msg;
      NSString *code = s->code;
      s->invoker->invokeAsync([fn, msg, code](jsi::Runtime &rt) {
        try {
          // Expo's own coded-error shape ({ message, code }).
          fn->call(rt, expo::makeCodedError(
                           rt, code ?: @"ERR_EXPO_MODULE",
                           msg ?: @"Expo module call failed"));
        } catch (...) {
        }
      });
    }
  };

  [ctx callFunction:fnName
      onModule:moduleName
      withArgs:nargs
      resolve:^(id result) {
        std::lock_guard<std::mutex> lk(s->m);
        if (s->done) return;
        s->done = true;
        s->ok = true;
        s->result = result;
        settle(s);
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        std::lock_guard<std::mutex> lk(s->m);
        if (s->done) return;
        s->done = true;
        s->ok = false;
        s->code = code ?: @"ERR_EXPO_MODULE";
        s->msg = message ?: @"Expo module call failed";
        settle(s);
      }];

  std::lock_guard<std::mutex> lk(s->m);
  if (s->done) {
    // Fired synchronously → a sync Function. Return the value/throw directly.
    if (s->ok) {
      return jsiFromId(rt, s->result);
    }
    throw jsi::JSError(
        rt, s->msg ? std::string([s->msg UTF8String]) : std::string("error"));
  }
  // Async → build the Promise now (the pending callback is blocked on s->m and
  // will settle once we store resolve/reject and release).
  auto resolveOut = std::make_shared<std::shared_ptr<jsi::Function>>();
  auto rejectOut = std::make_shared<std::shared_ptr<jsi::Function>>();
  jsi::Function executor = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "executor"), 2,
      [resolveOut, rejectOut](
          jsi::Runtime &rt, const jsi::Value &, const jsi::Value *a, size_t n)
          -> jsi::Value {
        if (n >= 2) {
          *resolveOut =
              std::make_shared<jsi::Function>(a[0].getObject(rt).getFunction(rt));
          *rejectOut =
              std::make_shared<jsi::Function>(a[1].getObject(rt).getFunction(rt));
        }
        return jsi::Value::undefined();
      });
  jsi::Object promise = rt.global()
                            .getPropertyAsFunction(rt, "Promise")
                            .callAsConstructor(rt, executor)
                            .getObject(rt);
  s->jsResolve = *resolveOut;
  s->jsReject = *rejectOut;
  return jsi::Value(rt, promise);
}

jsi::Function makeMethod(
    jsi::Runtime &rt,
    NSString *moduleName,
    NSString *fnName,
    std::shared_ptr<CallInvoker> invoker) {
  return jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forUtf8(rt, [fnName UTF8String]), 0,
      [moduleName, fnName, invoker](
          jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
          size_t count) -> jsi::Value {
        return callExpoFunction(rt, moduleName, fnName, invoker, args, count);
      });
}

// ---------------------------------------------------------------------------
// Cross-runtime plumbing for EVENTS and live PROPERTIES.
//
// Both a module's event emission and its property getters run against the MAIN
// runtime (that's where Expo built the module's JS object). We never read those
// from the worker runtime. Instead:
//   * events     — on the MAIN thread we subscribe a native listener to the
//                  module's main-runtime JS object; when it fires we marshal the
//                  payload to a native value and re-dispatch it into the WORKER
//                  runtime on the worker thread.
//   * properties — on the MAIN thread we read the module object's getter, marshal
//                  the value to native, and hand it back to the (briefly blocked)
//                  worker thread.
// The main JS thread never synchronously waits on a worker, so a bounded block
// from worker→main cannot deadlock.
// ---------------------------------------------------------------------------

// Runs `body` on the MAIN JS thread and blocks the calling (worker) thread until
// it completes or `timeoutMs` elapses. Returns true if it ran. `body` receives the
// main runtime and executes with synchronized access to it.
bool runOnMainRuntimeSync(void (^body)(jsi::Runtime &mainRt), int timeoutMs = 4000) {
  id<RNWExpoAppContext> ctx = gAppContext;
  if (!ctx) {
    return false;
  }
  EXJavaScriptRuntime *mainRuntime = [ctx _runtime];
  if (!mainRuntime) {
    return false;
  }
  std::shared_ptr<CallInvoker> mainInvoker = [mainRuntime callInvoker];
  if (!mainInvoker) {
    return false;
  }
  auto mtx = std::make_shared<std::mutex>();
  auto cv = std::make_shared<std::condition_variable>();
  auto done = std::make_shared<bool>(false);
  mainInvoker->invokeAsync([body, mtx, cv, done](jsi::Runtime &mainRt) {
    @autoreleasepool {
      body(mainRt);
    }
    {
      std::lock_guard<std::mutex> lk(*mtx);
      *done = true;
    }
    cv->notify_all();
  });
  std::unique_lock<std::mutex> lk(*mtx);
  return cv->wait_for(
      lk, std::chrono::milliseconds(timeoutMs), [&] { return *done; });
}

// Per-worker event bridge. Owns the worker CallInvoker and the worker-side listener
// registry, and remembers which (module,event) pairs are already wired on the main
// side. Held by the WorkerExpoModules host and captured by each module object's
// addListener closure.
struct ExpoEventBridge {
  std::mutex mutex;
  std::shared_ptr<CallInvoker> workerInvoker;
  // module -> the worker-runtime module object. It's a real Expo EventEmitter
  // (inherits expo.EventEmitter.prototype), so it owns its own listener list via
  // Expo's NativeState; we just emit into it. Listener bookkeeping is Expo's job.
  std::unordered_map<std::string, std::shared_ptr<jsi::Value>> moduleObjects;
  // "module\x1fevent" already bridged on the main runtime -> the native bridge fn
  // (kept alive so we could remove it; created on & owned by the main runtime).
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> mainBridges;

  static std::string key(const std::string &module, const std::string &event) {
    return module + "\x1f" + event;
  }
};

// On the MAIN runtime, subscribe a single native listener to `module`'s JS object
// for `event`. When it fires, marshal the payload to a native value and re-dispatch
// into the worker runtime. Idempotent per (module,event). Runs the registration on
// the main thread (does not block the worker).
void ensureMainEventBridge(
    const std::shared_ptr<ExpoEventBridge> &bridge,
    NSString *moduleName,
    const std::string &event) {
  const std::string module = [moduleName UTF8String];
  const std::string mapKey = ExpoEventBridge::key(module, event);
  {
    std::lock_guard<std::mutex> lk(bridge->mutex);
    if (bridge->mainBridges.find(mapKey) != bridge->mainBridges.end()) {
      return; // already wired (or wiring in flight)
    }
    bridge->mainBridges.emplace(mapKey, nullptr); // reserve
  }

  id<RNWExpoAppContext> ctx = gAppContext;
  if (!ctx) {
    return;
  }
  EXJavaScriptRuntime *mainRuntime = [ctx _runtime];
  std::shared_ptr<CallInvoker> mainInvoker =
      mainRuntime ? [mainRuntime callInvoker] : nullptr;
  if (!mainInvoker) {
    return;
  }

  std::weak_ptr<ExpoEventBridge> weakBridge = bridge;
  mainInvoker->invokeAsync([weakBridge, ctx, moduleName, module, event, mapKey,
                            mainInvoker](jsi::Runtime &mainRt) {
    auto bridge = weakBridge.lock();
    if (!bridge) {
      return;
    }
    EXJavaScriptObject *moduleObj = [ctx getNativeModuleObject:moduleName];
    if (!moduleObj) {
      return;
    }
    jsi::Object &emitter = *[moduleObj get];
    if (!emitter.hasProperty(mainRt, "addListener")) {
      return; // module has no events
    }

    // Native listener, created in & bound to the MAIN runtime.
    jsi::Function bridgeFn = jsi::Function::createFromHostFunction(
        mainRt, jsi::PropNameID::forAscii(mainRt, "__rnwEventBridge"), 1,
        [weakBridge, module, event, mainInvoker](
            jsi::Runtime &mainRt, const jsi::Value &, const jsi::Value *args,
            size_t count) -> jsi::Value {
          auto bridge = weakBridge.lock();
          if (!bridge) {
            return jsi::Value::undefined();
          }
          // Marshal the payload to a native value on the MAIN thread/runtime.
          id payload =
              (count >= 1) ? idFromJsi(mainRt, args[0], mainInvoker) : [NSNull null];
          std::shared_ptr<CallInvoker> workerInvoker = bridge->workerInvoker;
          if (!workerInvoker) {
            return jsi::Value::undefined();
          }
          std::weak_ptr<ExpoEventBridge> wb = bridge;
          workerInvoker->invokeAsync([wb, module, event, payload](
                                         jsi::Runtime &workerRt) {
            auto bridge = wb.lock();
            if (!bridge) {
              return;
            }
            std::shared_ptr<jsi::Value> objVal;
            {
              std::lock_guard<std::mutex> lk(bridge->mutex);
              auto it = bridge->moduleObjects.find(module);
              if (it != bridge->moduleObjects.end()) {
                objVal = it->second;
              }
            }
            if (!objVal) {
              return;
            }
            // Emit into the worker's EventEmitter object — Expo's own dispatch
            // invokes every listener the worker registered via `addListener`.
            try {
              jsi::Object emitter = objVal->asObject(workerRt);
              std::vector<jsi::Value> a;
              a.emplace_back(jsiFromId(workerRt, payload));
              expo::EventEmitter::emitEvent(workerRt, emitter, event, a);
            } catch (...) {
            }
          });
          return jsi::Value::undefined();
        });

    auto stored = std::make_shared<jsi::Function>(std::move(bridgeFn));
    {
      std::lock_guard<std::mutex> lk(bridge->mutex);
      bridge->mainBridges[mapKey] = stored;
    }
    // moduleObj.addListener(event, bridgeFn) — Expo's C++ EventEmitter fires
    // `startObserving` when this is the first listener, so the module starts
    // emitting natively.
    try {
      jsi::Function addListener =
          emitter.getPropertyAsFunction(mainRt, "addListener");
      addListener.callWithThis(
          mainRt, emitter,
          {jsi::String::createFromUtf8(mainRt, event),
           jsi::Value(mainRt, *stored)});
    } catch (...) {
    }
  });
}

// Names always present on an Expo native-module JS object that are NOT module
// properties (they're the EventEmitter surface / observing hooks).
bool isReservedModuleMember(const std::string &name) {
  static NSSet *reserved = [NSSet setWithArray:@[
    @"addListener", @"removeListener", @"removeListeners", @"removeAllListeners",
    @"emit", @"listenerCount", @"startObserving", @"stopObserving",
    @"__expo_onStartListeningToEvent", @"__expo_onStopListeningToEvent",
    @"constructor", @"prototype", @"hasListeners"
  ]];
  return [reserved containsObject:[NSString stringWithUTF8String:name.c_str()]] != NO;
}

// On the MAIN runtime, enumerate a module's dynamic PROPERTY names: every
// enumerable own/prototype name minus the functions and constants we already know
// about (from the config) minus the reserved emitter members. Blocks the worker
// briefly; runs once per module (at build time).
std::vector<std::string> readModulePropertyNames(
    NSString *moduleName, NSDictionary *constants, NSArray *methods) {
  NSMutableSet *known = [NSMutableSet set];
  for (NSString *k in constants) {
    [known addObject:k];
  }
  for (NSDictionary *m in methods) {
    if (m[@"name"]) {
      [known addObject:m[@"name"]];
    }
  }
  auto out = std::make_shared<std::vector<std::string>>();
  id<RNWExpoAppContext> ctx = gAppContext;
  if (!ctx) {
    return *out;
  }
  runOnMainRuntimeSync(^(jsi::Runtime &mainRt) {
    EXJavaScriptObject *moduleObj = [ctx getNativeModuleObject:moduleName];
    if (!moduleObj) {
      return;
    }
    for (NSString *name in [moduleObj getPropertyNames]) {
      std::string n = [name UTF8String];
      if ([known containsObject:name] || isReservedModuleMember(n) ||
          n.rfind("__expo", 0) == 0) {
        continue;
      }
      out->push_back(n);
    }
  });
  return *out;
}

// Reads a single property's current value on the MAIN runtime, marshalled to a
// native value. Blocks the worker briefly. Returns nil on failure/timeout.
id readModulePropertyValue(NSString *moduleName, const std::string &propName) {
  id<RNWExpoAppContext> ctx = gAppContext;
  if (!ctx) {
    return nil;
  }
  auto box = std::make_shared<id>(nil);
  NSString *prop = [NSString stringWithUTF8String:propName.c_str()];
  std::shared_ptr<CallInvoker> mainInvoker = [[ctx _runtime] callInvoker];
  bool ran = runOnMainRuntimeSync(^(jsi::Runtime &mainRt) {
    EXJavaScriptObject *moduleObj = [ctx getNativeModuleObject:moduleName];
    if (!moduleObj) {
      return;
    }
    // Invokes the property's getter on the main runtime, then marshals to native.
    EXJavaScriptValue *value = [moduleObj getProperty:prop];
    *box = idFromJsi(mainRt, [value get], mainInvoker);
  });
  return ran ? *box : nil;
}

// Build a PLAIN JS object for a module: constants converted once and functions
// created once, so subsequent property/method access is a native Hermes lookup —
// no per-access host-object dispatch. This is leaner than Expo's own per-access
// LazyObject path. Events and live properties are wired through the bridge.
jsi::Value buildModuleObject(
    jsi::Runtime &rt,
    NSString *moduleName,
    NSDictionary *constants,
    NSArray *methods,
    const std::shared_ptr<CallInvoker> &invoker,
    const std::shared_ptr<ExpoEventBridge> &bridge) {
  jsi::Object mod(rt);
  for (NSString *key in constants) {
    mod.setProperty(rt, [key UTF8String], jsiFromId(rt, constants[key]));
  }
  for (NSDictionary *m in methods) {
    NSString *fnName = m[@"name"];
    if (fnName) {
      mod.setProperty(
          rt, [fnName UTF8String], makeMethod(rt, moduleName, fnName, invoker));
    }
  }
  // Events: make this a REAL Expo EventEmitter by inheriting the prototype that
  // `expo::EventEmitter::installClass` set up (addListener/removeListener/emit/
  // listenerCount/subscriptions — all Expo's, all reused). We supply only the
  // `startObserving`/`stopObserving` hooks: Expo invokes them on the first/last
  // listener, and that's where we wire (and could unwire) the cross-runtime native
  // bridge on the MAIN runtime. Then we register this object so the bridge can emit
  // into it.
  jsi::Object global = rt.global();
  jsi::Object expoObj = global.hasProperty(rt, "expo")
                            ? global.getPropertyAsObject(rt, "expo")
                            : jsi::Object(rt);
  if (expoObj.hasProperty(rt, "EventEmitter")) {
    jsi::Object emitterProto = expoObj.getPropertyAsObject(rt, "EventEmitter")
                                   .getPropertyAsObject(rt, "prototype");
    global.getPropertyAsObject(rt, "Object")
        .getPropertyAsFunction(rt, "setPrototypeOf")
        .call(rt, mod, emitterProto);

    mod.setProperty(
        rt, "startObserving",
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, "startObserving"), 1,
            [moduleName, bridge](
                jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                size_t count) -> jsi::Value {
              if (count >= 1 && args[0].isString()) {
                ensureMainEventBridge(
                    bridge, moduleName, args[0].getString(rt).utf8(rt));
              }
              return jsi::Value::undefined();
            }));
    mod.setProperty(
        rt, "stopObserving",
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, "stopObserving"), 1,
            [](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t)
                -> jsi::Value { return jsi::Value::undefined(); }));

    std::lock_guard<std::mutex> lk(bridge->mutex);
    bridge->moduleObjects[[moduleName UTF8String]] =
        std::make_shared<jsi::Value>(rt, mod);
  }

  // Live properties: any dynamic `Property(...)` on the module becomes a JS getter
  // that reads the value on the main runtime at access time (values can change).
  // Uses Expo's own `common::defineProperty` descriptor helper.
  for (const std::string &propName :
       readModulePropertyNames(moduleName, constants, methods)) {
    expo::common::defineProperty(
        rt, &mod, propName.c_str(),
        expo::common::PropertyDescriptor{
            .configurable = true,
            .enumerable = true,
            .get =
                [moduleName, propName](jsi::Runtime &rt, jsi::Object) -> jsi::Value {
                  return jsiFromId(rt, readModulePropertyValue(moduleName, propName));
                },
        });
  }

  return jsi::Value(std::move(mod));
}

// `global.expo.modules` host object: resolves a module name to its (cached) plain
// module object. The cache makes repeated `expo.modules.X` return the SAME object
// and skips rebuilding — O(1) after the first access.
class WorkerExpoModules : public jsi::HostObject {
 public:
  WorkerExpoModules(
      NSDictionary *allConstants,
      NSDictionary *allMethods,
      std::shared_ptr<CallInvoker> invoker,
      std::shared_ptr<ExpoEventBridge> bridge)
      : allConstants_(allConstants ?: @{}),
        allMethods_(allMethods ?: @{}),
        invoker_(std::move(invoker)),
        bridge_(std::move(bridge)) {}

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
    std::string prop = name.utf8(rt);
    auto it = cache_.find(prop);
    if (it != cache_.end()) {
      return jsi::Value(rt, it->second);
    }
    NSString *moduleName = [NSString stringWithUTF8String:prop.c_str()];
    id<RNWExpoAppContext> ctx = gAppContext;
    if (!ctx || ![ctx hasModule:moduleName]) {
      return jsi::Value::undefined();
    }
    jsi::Value mod = buildModuleObject(
        rt, moduleName, allConstants_[moduleName],
        (NSArray *)allMethods_[moduleName], invoker_, bridge_);
    auto inserted = cache_.emplace(prop, jsi::Value(rt, mod));
    return jsi::Value(rt, inserted.first->second);
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
    std::vector<jsi::PropNameID> names;
    id<RNWExpoAppContext> ctx = gAppContext;
    if (ctx) {
      for (NSString *n in [ctx getModuleNames]) {
        names.push_back(jsi::PropNameID::forUtf8(rt, [n UTF8String]));
      }
    }
    return names;
  }

 private:
  NSDictionary *allConstants_;
  NSDictionary *allMethods_;
  std::shared_ptr<CallInvoker> invoker_;
  std::shared_ptr<ExpoEventBridge> bridge_;
  std::unordered_map<std::string, jsi::Value> cache_;
};

bool installExpoIntoWorker(jsi::Runtime &rt, std::shared_ptr<CallInvoker> invoker) {
  id<RNWExpoAppContext> ctx = gAppContext;
  NSLog(@"[RNWorkerExpo] installExpoIntoWorker: appContext=%@ invoker=%d",
        ctx ? @"present" : @"NIL", invoker ? 1 : 0);
  if (!ctx || !invoker) {
    return false;
  }

  // Snapshot the app's module config (constants + method names) — a plain native
  // dictionary, no runtime involved.
  NSDictionary *config = [[ctx expoModulesConfig] toDictionary];
  NSDictionary *allConstants = config[@"modulesConstants"] ?: @{};
  NSDictionary *allMethods = config[@"exportedMethods"] ?: @{};

  // Build `global.expo = { modules: <our host object> }` in the WORKER runtime.
  jsi::Object global = rt.global();
  jsi::Object expo = global.hasProperty(rt, "expo")
      ? global.getPropertyAsObject(rt, "expo")
      : jsi::Object(rt);
  auto bridge = std::make_shared<ExpoEventBridge>();
  bridge->workerInvoker = invoker;
  auto modulesHost = std::make_shared<WorkerExpoModules>(
      allConstants, allMethods, invoker, bridge);
  expo.setProperty(
      rt, "modules", jsi::Object::createFromHostObject(rt, modulesHost));
  global.setProperty(rt, "expo", expo);

  // Install Expo's own `EventEmitter` class into the WORKER runtime. Expo's
  // `installClass` stashes it on `global.expo` (which we just created) and needs
  // nothing else from Expo's normal bootstrap, so it's safe here. Module objects
  // then inherit its prototype to become real emitters.
  try {
    expo::EventEmitter::installClass(rt);
  } catch (...) {
    NSLog(@"[RNWorkerExpo] EventEmitter::installClass failed (events disabled)");
  }

  NSLog(@"[RNWorkerExpo] installed global.expo.modules (native-forwarding) OK; "
        @"modules=%lu",
        (unsigned long)[[ctx getModuleNames] count]);
  return true;
}

// ---------------------------------------------------------------------------
// A REAL per-worker AppContext (preferred path).
//
// Everything above forwards to the app's single AppContext, whose module objects
// live on the MAIN runtime — so events have to be bridged from there and property
// reads block the worker on the main JS thread. Both break the isolation rules.
//
// Expo can simply be installed into the worker runtime instead: build an
// `EXJavaScriptRuntime` around the worker's runtime + CallInvoker, hand it to the
// Swift factory (RNWorkersExpoWorkerContext), and Expo's own `prepareRuntime()`
// installs `global.expo` and the modules host object against the WORKER runtime.
// The worker then gets its own module instances, with functions, events and
// properties all running natively on its own thread.
//
// The runtime object is built here rather than in Swift because
// `initWithRuntime:callInvoker:` is inside `#ifdef __cplusplus`.
// ---------------------------------------------------------------------------

// Returns a teardown thunk on success, or nullopt when this SDK/app cannot build a
// per-worker context (caller falls back to the forwarding installer).
static std::optional<std::function<void()>> installRealExpoWorkerContext(
    jsi::Runtime &rt,
    const std::shared_ptr<CallInvoker> &invoker)
{
  Class factory = NSClassFromString(@"RNWorkersExpoWorkerContext");
  if (factory == Nil || ![factory respondsToSelector:@selector(createWithRuntime:)]) {
    return std::nullopt;
  }

  // A runtime object bound to THIS worker. Expo only ever schedules through the
  // call invoker it was given, so all of its work stays on the worker thread.
  // MUST be Expo's `ExpoRuntime`, not the base `EXJavaScriptRuntime`.
  //
  // `AppContext._runtime` is typed `ExpoRuntime?` — a FINAL Swift subclass
  // (`@objc(EXRuntime) public final class ExpoRuntime: JavaScriptRuntime`) — so a
  // base-class instance fails the Swift-side cast every time and can never pass
  // it. The subclass is also semantically required: `initializeCoreObject`, which
  // installs `global.expo`, is declared on it and is `internal`.
  //
  // Allocated by name because ExpoModulesCore ships no ObjC header for the Swift
  // subclass; it declares no designated initializer, so it inherits
  // `initWithRuntime:callInvoker:` from the base. An SDK without `EXRuntime` falls
  // back to the forwarding installer rather than failing.
  Class expoRuntimeClass = NSClassFromString(@"EXRuntime");
  if (expoRuntimeClass == Nil) {
    NSLog(@"[RNWorkerExpo] EXRuntime class absent on this SDK -> forwarding installer");
    return std::nullopt;
  }
  EXJavaScriptRuntime *workerRuntime =
      [[expoRuntimeClass alloc] initWithRuntime:&rt callInvoker:invoker];
  if (!workerRuntime) {
    return std::nullopt;
  }

  id<RNWExpoWorkerContext> context =
      [(id<RNWExpoWorkerContext>)factory createWithRuntime:workerRuntime];
  if (!context) {
    NSLog(@"[RNWorkerExpo] per-worker AppContext unavailable on this SDK -> "
          @"falling back to the forwarding installer");
    return std::nullopt;
  }
  if (![context hasModules]) {
    // An empty registry means the app's generated provider didn't resolve; the
    // forwarding path reaches the app's real modules, so prefer it.
    [context invalidate];
    NSLog(@"[RNWorkerExpo] per-worker AppContext has no modules -> falling back");
    return std::nullopt;
  }

  NSLog(@"[RNWorkerExpo] per-worker AppContext installed (native, worker-owned)");
  // Runs on the worker thread with the runtime still alive (Worker.cpp's
  // setPreDestroy), which is required: unsetting the runtime is what releases
  // Expo's JS objects for this context.
  return std::function<void()>([context, workerRuntime]() {
    [context invalidate];
    (void)workerRuntime;
  });
}

__attribute__((constructor)) static void registerInstaller() {
  facebook::react::workers::setExpoModulesInstaller(
      [](jsi::Runtime &rt,
         std::shared_ptr<CallInvoker> invoker) -> std::function<void()> {
        // Preferred: Expo running natively inside the worker, isolated from the
        // app's context. Falls back to the forwarding shim where that isn't
        // reachable (older/newer SDK surfaces), so no app loses Expo support.
        if (auto teardown = installRealExpoWorkerContext(rt, invoker)) {
          return *teardown;
        }
        installExpoIntoWorker(rt, std::move(invoker));
        // The forwarding shim holds no per-worker native state.
        return {};
      });
}

} // namespace

// Store the context for the installer compiled above.
static void RNWorkersStoreExpoAppContext(id appContext) {
  gAppContext = (id<RNWExpoAppContext>)appContext;
}

#else

// No ObjC Expo JSI surface here: either a bare React Native app (no
// ExpoModulesCore), or an Expo SDK whose JSI classes moved to Swift (56+). In
// the latter case the installer reaches Expo through RNWorkersExpoJSI.swift, so
// there is nothing for this file to store.
static void RNWorkersStoreExpoAppContext(id appContext) {
  (void)appContext;
}

#endif // Expo ObjC JSI availability

// Defined unconditionally, OUTSIDE the guard above. The podspec compiles the
// companion Swift module (RNWorkersExpoModule.swift) whenever expo-modules-core
// resolves, and its OnCreate calls +registerAppContext: on every SDK — so
// compiling this class away leaves an undefined symbol at link time instead of a
// clean no-op. The class always exists; only what it does with the context
// varies by SDK.
#if defined(RNWORKERS_EXPO_SWIFT_JSI) && !defined(RNWORKERS_HAS_EXPO_MODULES)
// SDK 56+ installer, in WorkerExpoModulesSwiftJSI.mm. Declared and called here on
// purpose: that file holds nothing the app references, so as part of a static
// archive its object file — and any static initializer in it — would be dropped
// by the linker. This call is its anchor. RNWorkersExpoBridge is referenced from
// Swift, so THIS translation unit is always linked.
extern "C" void RNWorkersRegisterExpoSwiftJSIInstaller(void);
#endif

@implementation RNWorkersExpoBridge
+ (void)registerAppContext:(id)appContext {
  NSLog(@"[RNWorkerExpo] registerAppContext: %@ (companion Expo module OnCreate ran)",
        appContext ? @"present" : @"NIL");
  RNWorkersStoreExpoAppContext(appContext);
#if defined(RNWORKERS_EXPO_SWIFT_JSI) && !defined(RNWORKERS_HAS_EXPO_MODULES)
  RNWorkersRegisterExpoSwiftJSIInstaller();
#endif
}
@end
