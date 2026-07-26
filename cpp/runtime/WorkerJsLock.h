#pragma once

#include <jsi/jsi.h>

#include <memory>
#include <mutex>

namespace facebook::react::workers {

// Serializes every entry into a worker's JS runtime.
//
// A worker runtime is normally driven by exactly one thread (its own, or the
// main thread for UIWorker), so nothing needed guarding. Once JS can be entered
// from an arbitrary thread — see ThreadTarget / the experimental `Thread` API —
// that stops being true, and the runtime needs mutual exclusion.
//
// Hermes does not require thread *affinity*: its stack-overflow guard
// re-reads the current thread's stack bounds when execution moves threads
// (hermes/Support/StackOverflowGuard.h), and the GC is synchronous on the
// mutator. What it requires is that no two threads are inside the runtime at
// once. This lock is the whole of that guarantee, so EVERY path that touches
// jsi::Runtime — task loop, timers, CallInvoker, inspector, startup, teardown —
// must be wrapped in a WorkerJsScope.
//
// The mutex is recursive so nested entries (a host function that re-enters
// through the same door) are free re-locks rather than deadlocks.
class WorkerRuntimeLock {
 public:
  std::recursive_mutex mutex;

  // Depth of nested JS scopes. A plain int is correct precisely BECAUSE the
  // mutex serializes every mutation — only the lock holder ever touches it.
  int enterDepth = 0;

  // Non-null between runtime creation and destruction. Both transitions happen
  // while holding `mutex`, so a foreign thread that took the lock can trust it:
  // either the runtime is alive for the whole scope, or it was already gone.
  jsi::Runtime* runtime = nullptr;
};

// RAII entry into a worker runtime. Takes the lock, tracks depth, and drains
// microtasks when the OUTERMOST scope unwinds — mirroring how an engine empties
// its job queue once control returns to the host. Draining at a nested depth
// would run promise continuations while JS is still on the stack.
//
// Callers must check `alive()` before touching `runtime()`: a scope entered from
// a foreign thread can legitimately find the runtime already destroyed (worker
// terminated while the task was queued).
class WorkerJsScope {
 public:
  explicit WorkerJsScope(std::shared_ptr<WorkerRuntimeLock> lock);
  ~WorkerJsScope();

  WorkerJsScope(const WorkerJsScope&) = delete;
  WorkerJsScope& operator=(const WorkerJsScope&) = delete;

  bool alive() const {
    return lock_ != nullptr && lock_->runtime != nullptr;
  }

  // Only valid while alive().
  jsi::Runtime& runtime() const {
    return *lock_->runtime;
  }

 private:
  std::shared_ptr<WorkerRuntimeLock> lock_;
};

} // namespace facebook::react::workers
