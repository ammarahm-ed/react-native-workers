// Apple implementation of the worker autorelease-pool hooks (WorkerThreadScope.h).
//
// A worker runs on a raw std::thread with no run loop and no ambient pool, so any
// ObjC object autoreleased during its life — notably the EXJavaScriptValue
// wrappers Expo's per-worker AppContext creates, each owning a jsi::Value — sits
// in the thread's top-level pool until pthread_exit drains it. That drain happens
// after the worker body has destroyed its jsi::Runtime, so ~Value dereferenced a
// freed runtime and crashed teardown.
//
// Registering these lets the worker body own the pool and pop it while the runtime
// is still alive.
#import <Foundation/Foundation.h>

#import <objc/objc.h>

#include "../cpp/runtime/WorkerThreadScope.h"

#include <mutex>

// Declared by the ObjC runtime; the public spelling of push/pop for a pool that
// must outlive a single lexical scope (an @autoreleasepool block cannot span the
// worker body, whose teardown point is chosen at runtime).
extern "C" void *objc_autoreleasePoolPush(void);
extern "C" void objc_autoreleasePoolPop(void *);

namespace {

void *pushPool() {
  return objc_autoreleasePoolPush();
}

void popPool(void *token) {
  if (token != nullptr) {
    objc_autoreleasePoolPop(token);
  }
}

} // namespace

namespace facebook::react::workers {

// Called explicitly from HermesWorkerHost — NOT a load-time constructor.
//
// This pod links as a static archive, and a linker drops any object file nothing
// references. A file whose only content is `__attribute__((constructor))`
// therefore vanishes silently: the hooks are never registered, every push returns
// null, every pop is a no-op, and the crash this exists to prevent comes back
// looking exactly as it did before the fix. (The Android registrars are
// force-linked for the same reason — see WorkerTurboModulesAndroid.cpp.)
void installAppleAutoreleasePoolHooks() {
  static std::once_flag once;
  std::call_once(once, [] {
    setWorkerAutoreleasePoolHooks(&pushPool, &popPool);
  });
}

} // namespace facebook::react::workers
