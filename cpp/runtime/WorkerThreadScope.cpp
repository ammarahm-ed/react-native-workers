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

namespace {
AutoreleasePoolPush& poolPushSlot() {
  static AutoreleasePoolPush fn = nullptr;
  return fn;
}
AutoreleasePoolPop& poolPopSlot() {
  static AutoreleasePoolPop fn = nullptr;
  return fn;
}
} // namespace

void setWorkerAutoreleasePoolHooks(
    AutoreleasePoolPush push,
    AutoreleasePoolPop pop) {
  poolPushSlot() = push;
  poolPopSlot() = pop;
}

void* pushWorkerAutoreleasePool() {
  auto push = poolPushSlot();
  return push ? push() : nullptr;
}

void popWorkerAutoreleasePool(void* token) {
  auto pop = poolPopSlot();
  // A null token is still meaningful on Apple (it is a valid pool token), so the
  // hook decides; only the absence of a hook means "nothing to do".
  if (pop) pop(token);
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
