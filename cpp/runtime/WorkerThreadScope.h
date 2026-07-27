#pragma once

#include <functional>

namespace facebook::react::workers {

// Platform hook for wrapping a worker thread's entire body.
//
// On Android, worker runtimes run on a raw std::thread that has no Java frame on
// its stack, so JNI FindClass resolves against the system classloader and misses
// app classes (e.g. com.facebook.react.bridge.Arguments used deep inside the
// TurboModule machinery). The Android implementation registers a runner that
// runs the worker body inside fbjni's ThreadScope::WithClassLoader, which keeps
// an app-classloader Java frame on the stack for the worker's whole lifetime so
// every JNI FindClass — during install AND later module access — succeeds.
//
// Platforms that don't need this (iOS, host) leave the runner unset and the body
// runs directly.
using ThreadScopeRunner = std::function<void(const std::function<void()>&)>;

// Register the platform runner. Typically called once at library load.
void setWorkerThreadScopeRunner(ThreadScopeRunner runner);

// Run `body` via the registered runner, or directly if none is registered.
void runInWorkerThreadScope(const std::function<void()>& body);

// Autorelease-pool control for a worker thread (Apple only; no-ops elsewhere).
//
// A worker thread is a raw std::thread, so ObjC temporaries it creates land in
// the thread's TOP-LEVEL autorelease pool, which only drains at pthread_exit —
// i.e. AFTER the worker body has already destroyed its jsi::Runtime. Expo's
// per-worker AppContext puts EXJavaScriptValue objects (each holding a jsi::Value)
// in exactly that pool, so the drain ran ~Value against a dead runtime and
// segfaulted during teardown.
//
// The worker body therefore owns a pool explicitly: pushed on entry, popped
// deliberately once teardown has finished but while the runtime is STILL alive.
void* pushWorkerAutoreleasePool();
void popWorkerAutoreleasePool(void* token);

// Platform hook registration.
using AutoreleasePoolPush = void* (*)();
using AutoreleasePoolPop = void (*)(void*);
void setWorkerAutoreleasePoolHooks(AutoreleasePoolPush push, AutoreleasePoolPop pop);

#if defined(__APPLE__)
// Installs the Apple hooks (ios/WorkerAutoreleasePoolApple.mm). MUST be called,
// not left to a load-time constructor: this pod is a static archive and the
// linker drops object files nothing references.
void installAppleAutoreleasePoolHooks();
#endif

} // namespace facebook::react::workers
