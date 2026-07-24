#include "WorkerThreadScope.h"

#include <utility>

namespace facebook::react::workers {

namespace {
ThreadScopeRunner& runnerSlot() {
  static ThreadScopeRunner runner;
  return runner;
}
} // namespace

void setWorkerThreadScopeRunner(ThreadScopeRunner runner) {
  runnerSlot() = std::move(runner);
}

void runInWorkerThreadScope(const std::function<void()>& body) {
  auto& runner = runnerSlot();
  if (runner) {
    runner(body);
  } else {
    body();
  }
}
} // namespace facebook::react::workers
