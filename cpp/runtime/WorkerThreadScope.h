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

} // namespace facebook::react::workers
