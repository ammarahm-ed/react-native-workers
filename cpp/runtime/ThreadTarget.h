#pragma once

#include <functional>
#include <memory>
#include <string>

namespace facebook::react::workers {

// A thread a worker's JS can be temporarily executed on.
//
// This is deliberately NOT a second runtime: `post`ed work runs the worker's own
// runtime, on this thread, under the worker's WorkerRuntimeLock. See
// cpp/bindings/WorkerThreads.cpp for the JS-facing `Thread` API built on top.
//
// Targets are serial: one task at a time, FIFO. That is what makes ordering
// inside a target predictable; the runtime lock only guarantees that no two
// threads are in JS at once, not that they interleave in any particular order.
class ThreadTarget {
 public:
  virtual ~ThreadTarget() = default;

  // Enqueue work. Never blocks. Dropped silently if the target is shutting down.
  //
  // The closure must NOT capture jsi references. A queued task can be dropped
  // at shutdown, and it is destroyed with no runtime lock held — releasing a
  // jsi::Function there mutates runtime state from an unsynchronized thread.
  // Keep such references in a registry the worker owns and look them up inside
  // your WorkerJsScope (see cpp/bindings/WorkerThreads.cpp).
  virtual void post(std::function<void()> fn) = 0;

  // True when the calling thread is this target's thread.
  virtual bool isCurrent() const = 0;

  const std::string& name() const {
    return name_;
  }

 protected:
  explicit ThreadTarget(std::string name) : name_(std::move(name)) {}

 private:
  std::string name_;
};

// The platform main/UI thread, or null when no MainThreadScheduler is registered
// for this platform (same availability rule as UIWorker). Process-global and
// shared by every worker.
std::shared_ptr<ThreadTarget> mainThreadTarget();

// A fresh serial background thread owned by the caller.
//
// Destruction signals the thread to stop and returns immediately — it never
// joins. Joining would deadlock the common case: a worker tears its targets down
// while holding the runtime lock, and a target thread blocked on that very lock
// (waiting to enter JS) could never reach the stop flag. Instead the thread
// unwinds on its own: it wakes when the lock is released, finds the runtime
// unpublished, returns, and exits.
std::shared_ptr<ThreadTarget> makeSerialThreadTarget(std::string name);

// Name of the target whose thread is currently executing, or "" when the calling
// thread is not running a ThreadTarget task. Used for `Thread.current`.
const std::string& currentThreadTargetName();

} // namespace facebook::react::workers
