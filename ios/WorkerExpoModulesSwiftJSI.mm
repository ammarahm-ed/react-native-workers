// Expo SDK 56+ worker installer.
//
// Everything the SDK ≤55 installer (WorkerExpoModules.mm) leans on is gone here:
//
//   AppContext.expoModulesConfig            removed
//   AppContext.callFunction:onModule:…      removed
//   AppContext._runtime / getNativeModuleObject   no longer @objc
//   expo::convertJSIValueToObjCObject       removed (only ObjC→JS survives)
//
// What remains reachable is the module's own JavaScript object on the MAIN
// runtime, handed to us as a raw `jsi::Object *` by RNWorkersExpoJSI.swift (which
// gets it through Expo's public Swift API and `withUnsafePointee`). So this
// installer does everything at the JS level against that object — read a
// constant/property, call a function, subscribe to events — instead of going
// through native Expo APIs that no longer exist.
//
// Values cross the main↔worker runtime boundary through THIS library's own
// MessageCodec (structured clone), not Expo's converters. That is the same
// runtime-independent representation postMessage already uses, so it needs
// nothing from Expo and behaves identically to the rest of the library.
#import <Foundation/Foundation.h>

#if defined(RNWORKERS_EXPO_SWIFT_JSI) && !__has_include(<ExpoModulesCore/EXJavaScriptRuntime.h>) && \
    !__has_include(<ExpoModulesJSI/EXJavaScriptRuntime.h>)

#import <ReactCommon/CallInvoker.h>
#import <jsi/jsi.h>

#import <chrono>
#import <condition_variable>
#import <memory>
#import <mutex>
#import <string>
#import <utility>
#import <vector>

#import "../cpp/bindings/WorkerExpoModules.h"
#import "../cpp/core/MessageCodec.h"

namespace jsi = facebook::jsi;
using facebook::react::CallInvoker;
using facebook::react::workers::Message;

// Declared here rather than importing the Swift-generated header: a dependent
// static-lib pod cannot reliably import `ReactNativeWorkers-Swift.h`, and the
// selectors are pinned with explicit @objc names on the Swift side.
@interface RNWorkersExpoJSI : NSObject
+ (BOOL)isAvailable;
+ (BOOL)hasModule:(NSString *_Nonnull)name;
+ (NSArray<NSString *> *)moduleNames;
+ (void)withMainRuntime:(void (^_Nonnull)(void *_Nonnull runtimePointer))body;
+ (void)withModuleObject:(NSString *_Nonnull)moduleName
                    body:(void (^_Nonnull)(void *_Nonnull runtimePointer,
                                           const void *_Nullable objectPointer))body;
@end

namespace {

// How long a worker will wait for the main runtime before giving up. A hung main
// thread must degrade to `undefined`, never wedge the worker forever.
constexpr auto kMainRuntimeTimeout = std::chrono::seconds(5);

/// Runs `body` on the main runtime and blocks the CALLING (worker) thread until
/// it finishes. Returns false on timeout.
bool runOnMainRuntimeSync(void (^body)(jsi::Runtime &)) {
  auto mutex = std::make_shared<std::mutex>();
  auto cv = std::make_shared<std::condition_variable>();
  auto done = std::make_shared<bool>(false);

  [RNWorkersExpoJSI withMainRuntime:^(void *runtimePointer) {
    body(*reinterpret_cast<jsi::Runtime *>(runtimePointer));
    {
      std::lock_guard<std::mutex> lock(*mutex);
      *done = true;
    }
    cv->notify_all();
  }];

  std::unique_lock<std::mutex> lock(*mutex);
  return cv->wait_for(lock, kMainRuntimeTimeout, [done] { return *done; });
}

/// Same, but resolves a module's JS object first. `body` is skipped entirely when
/// the module does not exist.
bool withModuleObjectSync(const std::string &moduleName,
                          void (^body)(jsi::Runtime &, jsi::Object &)) {
  auto mutex = std::make_shared<std::mutex>();
  auto cv = std::make_shared<std::condition_variable>();
  auto done = std::make_shared<bool>(false);

  [RNWorkersExpoJSI
      withModuleObject:[NSString stringWithUTF8String:moduleName.c_str()]
                  body:^(void *runtimePointer, const void *objectPointer) {
                    if (objectPointer != nullptr) {
                      // Const-cast is safe: Expo hands us its own live object and
                      // the jsi API is non-const. The pointer is only valid for
                      // the duration of this callback (Swift's withUnsafePointee
                      // contract), which is why nothing below retains it.
                      auto *object = const_cast<jsi::Object *>(
                          reinterpret_cast<const jsi::Object *>(objectPointer));
                      body(*reinterpret_cast<jsi::Runtime *>(runtimePointer), *object);
                    }
                    {
                      std::lock_guard<std::mutex> lock(*mutex);
                      *done = true;
                    }
                    cv->notify_all();
                  }];

  std::unique_lock<std::mutex> lock(*mutex);
  return cv->wait_for(lock, kMainRuntimeTimeout, [done] { return *done; });
}

jsi::Value makeModuleFunction(jsi::Runtime &workerRt,
                              const std::string &moduleName,
                              const std::string &fnName,
                              std::shared_ptr<CallInvoker> workerInvoker);

/// `module.addListener(event, callback)`.
///
/// The callback belongs to the WORKER runtime and must never cross to the main
/// one. Instead a small host function is created on the main runtime and handed
/// to Expo; when the module emits, it structured-clones the payload and hops back
/// through the worker's CallInvoker to call the original callback in place.
jsi::Value makeAddListener(jsi::Runtime &workerRt,
                           const std::string &moduleName,
                           std::shared_ptr<CallInvoker> workerInvoker) {
  return jsi::Function::createFromHostFunction(
      workerRt, jsi::PropNameID::forAscii(workerRt, "addListener"), 2,
      [moduleName, workerInvoker](jsi::Runtime &rt, const jsi::Value &,
                                  const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[1].isObject() || !args[1].getObject(rt).isFunction(rt)) {
          throw jsi::JSError(rt, "addListener(eventName, callback) requires a function");
        }
        const std::string event = args[0].toString(rt).utf8(rt);
        auto callback = std::make_shared<jsi::Function>(args[1].getObject(rt).getFunction(rt));

        withModuleObjectSync(moduleName, ^(jsi::Runtime &mainRt, jsi::Object &module) {
          if (!module.hasProperty(mainRt, "addListener")) {
            return; // module emits no events
          }
          jsi::Function bridge = jsi::Function::createFromHostFunction(
              mainRt, jsi::PropNameID::forAscii(mainRt, "__rnwWorkerEventBridge"), 1,
              [workerInvoker, callback](jsi::Runtime &emitRt, const jsi::Value &,
                                        const jsi::Value *payload, size_t n) -> jsi::Value {
                std::shared_ptr<Message> encoded;
                try {
                  if (n > 0) {
                    encoded = std::make_shared<Message>(
                        facebook::react::workers::encode(emitRt, payload[0]));
                  } else {
                    encoded = std::make_shared<Message>(
                        facebook::react::workers::encode(emitRt, jsi::Value::undefined()));
                  }
                } catch (...) {
                  return jsi::Value::undefined(); // payload not cloneable; drop
                }
                workerInvoker->invokeAsync([encoded, callback](jsi::Runtime &workerRt) {
                  try {
                    callback->call(workerRt,
                                   facebook::react::workers::decode(workerRt, *encoded));
                  } catch (...) {
                  }
                });
                return jsi::Value::undefined();
              });
          try {
            module.getPropertyAsFunction(mainRt, "addListener")
                .callWithThis(mainRt, module,
                              jsi::String::createFromUtf8(mainRt, event),
                              std::move(bridge));
          } catch (...) {
          }
        });

        // Expo hands back a Subscription; mirror that shape so callers can hold
        // and drop it. Removal is not wired through yet — see the docs note.
        jsi::Object subscription(rt);
        subscription.setProperty(
            rt, "remove",
            jsi::Function::createFromHostFunction(
                rt, jsi::PropNameID::forAscii(rt, "remove"), 0,
                [](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) {
                  return jsi::Value::undefined();
                }));
        return jsi::Value(rt, subscription);
      });
}

/// One Expo module, projected into the worker runtime. Property reads and calls
/// are forwarded to the module's JS object on the main runtime.
class ExpoModuleProxy : public jsi::HostObject {
 public:
  ExpoModuleProxy(std::string name, std::shared_ptr<CallInvoker> invoker)
      : name_(std::move(name)), invoker_(std::move(invoker)) {}

  jsi::Value get(jsi::Runtime &workerRt, const jsi::PropNameID &propName) override {
    const std::string prop = propName.utf8(workerRt);
    if (prop == "addListener") {
      // NOT routed through makeModuleFunction: that structured-clones its
      // arguments, and a listener callback cannot be cloned. The callback has to
      // stay in the worker runtime and be invoked there.
      return makeAddListener(workerRt, name_, invoker_);
    }

    __block bool isFunction = false;
    __block bool hasValue = false;
    __block Message encoded;
    const std::string moduleName = name_;

    withModuleObjectSync(moduleName, ^(jsi::Runtime &mainRt, jsi::Object &module) {
      if (!module.hasProperty(mainRt, prop.c_str())) {
        return;
      }
      jsi::Value value = module.getProperty(mainRt, prop.c_str());
      if (value.isObject() && value.getObject(mainRt).isFunction(mainRt)) {
        isFunction = true;
        return;
      }
      try {
        encoded = facebook::react::workers::encode(mainRt, value);
        hasValue = true;
      } catch (...) {
        // Not structured-cloneable (a host object, a class…). Surfaced as
        // undefined rather than throwing across the runtime boundary.
      }
    });

    if (isFunction) {
      return makeModuleFunction(workerRt, moduleName, prop, invoker_);
    }
    if (hasValue) {
      try {
        return facebook::react::workers::decode(workerRt, encoded);
      } catch (...) {
      }
    }
    return jsi::Value::undefined();
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &workerRt) override {
    __block std::vector<std::string> names;
    const std::string moduleName = name_;
    withModuleObjectSync(moduleName, ^(jsi::Runtime &mainRt, jsi::Object &module) {
      jsi::Array props = module.getPropertyNames(mainRt);
      for (size_t i = 0; i < props.size(mainRt); i++) {
        names.push_back(props.getValueAtIndex(mainRt, i).toString(mainRt).utf8(mainRt));
      }
    });
    std::vector<jsi::PropNameID> result;
    result.reserve(names.size());
    for (const auto &name : names) {
      result.push_back(jsi::PropNameID::forUtf8(workerRt, name));
    }
    return result;
  }

 private:
  std::string name_;
  std::shared_ptr<CallInvoker> invoker_;
};

/// Calls `module.fn(...)` on the main runtime.
///
/// Expo has both sync functions (return a value) and async ones (return a
/// Promise). We block the worker only long enough to learn which: a plain result
/// comes straight back, a thenable turns into a worker Promise settled later
/// through the worker's own CallInvoker.
jsi::Value makeModuleFunction(jsi::Runtime &workerRt,
                              const std::string &moduleName,
                              const std::string &fnName,
                              std::shared_ptr<CallInvoker> workerInvoker) {
  return jsi::Function::createFromHostFunction(
      workerRt, jsi::PropNameID::forUtf8(workerRt, fnName), 0,
      [moduleName, fnName, workerInvoker](jsi::Runtime &rt, const jsi::Value &,
                                          const jsi::Value *args,
                                          size_t count) -> jsi::Value {
        // Encode arguments once, in the worker runtime.
        auto encodedArgs = std::make_shared<std::vector<Message>>();
        for (size_t i = 0; i < count; i++) {
          try {
            encodedArgs->push_back(facebook::react::workers::encode(rt, args[i]));
          } catch (const std::exception &e) {
            throw jsi::JSError(rt, std::string("Cannot pass argument to Expo module: ") + e.what());
          }
        }

        __block bool isAsync = false;
        __block bool hasResult = false;
        __block bool failed = false;
        __block std::string failure;
        __block Message result;
        // Kept alive for the async path: settled from the main runtime later.
        auto pending = std::make_shared<std::pair<std::shared_ptr<jsi::Function>,
                                                  std::shared_ptr<jsi::Function>>>();

        withModuleObjectSync(moduleName, ^(jsi::Runtime &mainRt, jsi::Object &module) {
          try {
            jsi::Function fn = module.getPropertyAsFunction(mainRt, fnName.c_str());
            std::vector<jsi::Value> callArgs;
            callArgs.reserve(encodedArgs->size());
            for (const auto &arg : *encodedArgs) {
              callArgs.push_back(facebook::react::workers::decode(mainRt, arg));
            }
            jsi::Value out = fn.callWithThis(mainRt, module,
                                             static_cast<const jsi::Value *>(callArgs.data()),
                                             callArgs.size());

            if (out.isObject() && out.getObject(mainRt).hasProperty(mainRt, "then")) {
              isAsync = true;
              return; // settled below, off the blocking path
            }
            result = facebook::react::workers::encode(mainRt, out);
            hasResult = true;
          } catch (const jsi::JSError &e) {
            failed = true;
            failure = e.getMessage();
          } catch (const std::exception &e) {
            failed = true;
            failure = e.what();
          }
        });

        if (failed) {
          throw jsi::JSError(rt, failure);
        }
        if (hasResult) {
          return facebook::react::workers::decode(rt, result);
        }
        if (!isAsync) {
          return jsi::Value::undefined();
        }

        // Async: hand back a worker Promise and settle it when the main-runtime
        // Promise resolves.
        auto promiseCtor = rt.global().getPropertyAsFunction(rt, "Promise");
        return promiseCtor.callAsConstructor(
            rt, jsi::Function::createFromHostFunction(
                    rt, jsi::PropNameID::forAscii(rt, "executor"), 2,
                    [moduleName, fnName, encodedArgs, workerInvoker](
                        jsi::Runtime &rt, const jsi::Value &, const jsi::Value *a,
                        size_t n) -> jsi::Value {
                      if (n < 2) return jsi::Value::undefined();
                      auto resolve = std::make_shared<jsi::Function>(
                          a[0].getObject(rt).getFunction(rt));
                      auto reject = std::make_shared<jsi::Function>(
                          a[1].getObject(rt).getFunction(rt));

                      [RNWorkersExpoJSI
                          withModuleObject:[NSString stringWithUTF8String:moduleName.c_str()]
                                      body:^(void *runtimePointer, const void *objectPointer) {
                                        if (objectPointer == nullptr) return;
                                        auto &mainRt = *reinterpret_cast<jsi::Runtime *>(runtimePointer);
                                        auto &module = *const_cast<jsi::Object *>(
                                            reinterpret_cast<const jsi::Object *>(objectPointer));
                                        try {
                                          jsi::Function fn =
                                              module.getPropertyAsFunction(mainRt, fnName.c_str());
                                          std::vector<jsi::Value> callArgs;
                                          for (const auto &arg : *encodedArgs) {
                                            callArgs.push_back(
                                                facebook::react::workers::decode(mainRt, arg));
                                          }
                                          jsi::Value out = fn.callWithThis(
                                              mainRt, module,
                                              static_cast<const jsi::Value *>(callArgs.data()),
                                              callArgs.size());
                                          jsi::Object promise = out.getObject(mainRt);
                                          auto settle = [workerInvoker, resolve, reject](
                                                            bool ok, Message payload) {
                                            auto msg = std::make_shared<Message>(std::move(payload));
                                            workerInvoker->invokeAsync(
                                                [ok, msg, resolve, reject](jsi::Runtime &workerRt) {
                                                  try {
                                                    jsi::Value v =
                                                        facebook::react::workers::decode(workerRt, *msg);
                                                    (ok ? resolve : reject)->call(workerRt, std::move(v));
                                                  } catch (...) {
                                                  }
                                                });
                                          };
                                          promise.getPropertyAsFunction(mainRt, "then")
                                              .callWithThis(
                                                  mainRt, promise,
                                                  jsi::Function::createFromHostFunction(
                                                      mainRt, jsi::PropNameID::forAscii(mainRt, "onOk"), 1,
                                                      [settle](jsi::Runtime &r, const jsi::Value &,
                                                               const jsi::Value *v, size_t c) -> jsi::Value {
                                                        // jsi::Value is move-only, so no ternary here.
                                                        if (c > 0) {
                                                          settle(true, facebook::react::workers::encode(r, v[0]));
                                                        } else {
                                                          settle(true, facebook::react::workers::encode(
                                                                           r, jsi::Value::undefined()));
                                                        }
                                                        return jsi::Value::undefined();
                                                      }),
                                                  jsi::Function::createFromHostFunction(
                                                      mainRt, jsi::PropNameID::forAscii(mainRt, "onErr"), 1,
                                                      [settle](jsi::Runtime &r, const jsi::Value &,
                                                               const jsi::Value *v, size_t c) -> jsi::Value {
                                                        std::string m = "Expo module call failed";
                                                        if (c > 0 && v[0].isObject() &&
                                                            v[0].getObject(r).hasProperty(r, "message")) {
                                                          m = v[0].getObject(r)
                                                                  .getProperty(r, "message")
                                                                  .toString(r)
                                                                  .utf8(r);
                                                        }
                                                        settle(false, facebook::react::workers::encode(
                                                                          r, jsi::String::createFromUtf8(r, m)));
                                                        return jsi::Value::undefined();
                                                      }));
                                        } catch (...) {
                                        }
                                      }];
                      return jsi::Value::undefined();
                    }));
      });
}

/// `global.expo.modules` — resolves module proxies lazily and caches them.
class ExpoModulesHost : public jsi::HostObject {
 public:
  explicit ExpoModulesHost(std::shared_ptr<CallInvoker> invoker)
      : invoker_(std::move(invoker)) {}

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &propName) override {
    const std::string name = propName.utf8(rt);
    auto it = cache_.find(name);
    if (it == cache_.end()) {
      if (![RNWorkersExpoJSI hasModule:[NSString stringWithUTF8String:name.c_str()]]) {
        return jsi::Value::undefined();
      }
      it = cache_.emplace(name, std::make_shared<ExpoModuleProxy>(name, invoker_)).first;
    }
    return jsi::Object::createFromHostObject(rt, it->second);
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
    std::vector<jsi::PropNameID> names;
    for (NSString *name in [RNWorkersExpoJSI moduleNames]) {
      names.push_back(jsi::PropNameID::forUtf8(rt, name.UTF8String));
    }
    return names;
  }

 private:
  std::shared_ptr<CallInvoker> invoker_;
  std::unordered_map<std::string, std::shared_ptr<ExpoModuleProxy>> cache_;
};

} // namespace

// Called explicitly from RNWorkersExpoBridge +registerAppContext: rather than run
// from a static initializer.
//
// This library links into the app as a STATIC archive, so an object file that
// nothing references is dropped — and with it any `__attribute__((constructor))`
// inside. WorkerExpoModules.mm gets away with one only because Swift references
// its RNWorkersExpoBridge class, which forces that TU to link. This file has no
// such anchor, so the call site below is what pulls it in. (Same reasoning as
// installAndroidMainThreadSchedulerFactory on the Android side.)
//
// Returns no teardown: this installer owns no per-worker native state — it only
// proxies to the app's shared AppContext.
extern "C" void RNWorkersRegisterExpoSwiftJSIInstaller(void) {
  facebook::react::workers::setExpoModulesInstaller(
      [](jsi::Runtime &rt, std::shared_ptr<CallInvoker> invoker) -> std::function<void()> {
        if (![RNWorkersExpoJSI isAvailable]) {
          NSLog(@"[RNWorkerExpo] AppContext not registered yet; global.expo absent in this worker");
          return {};
        }
        jsi::Object expo(rt);
        expo.setProperty(rt, "modules",
                         jsi::Object::createFromHostObject(
                             rt, std::make_shared<ExpoModulesHost>(invoker)));
        rt.global().setProperty(rt, "expo", std::move(expo));
        NSLog(@"[RNWorkerExpo] installed global.expo via Swift JSI bridge (SDK 56+)");
        return {};
      });
}

#endif // RNWORKERS_EXPO_SWIFT_JSI && no ObjC Expo JSI headers
