#include "WorkerJsLock.h"

#include <utility>

namespace facebook::react::workers {

WorkerJsScope::WorkerJsScope(std::shared_ptr<WorkerRuntimeLock> lock)
    : lock_(std::move(lock)) {
  if (!lock_) return;
  lock_->mutex.lock();
  ++lock_->enterDepth;
}

WorkerJsScope::~WorkerJsScope() {
  if (!lock_) return;
  if (--lock_->enterDepth <= 0) {
    lock_->enterDepth = 0;
    // Worker runtimes are configured withMicrotaskQueue(true), so promise jobs
    // only run when we drain them. A throwing microtask must never escape a
    // destructor.
    if (lock_->runtime != nullptr) {
      try {
        lock_->runtime->drainMicrotasks();
      } catch (...) {
      }
    }
  }
  lock_->mutex.unlock();
}

} // namespace facebook::react::workers
