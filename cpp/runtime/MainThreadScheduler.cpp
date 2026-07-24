#include "MainThreadScheduler.h"

#include <mutex>

namespace facebook::react::workers {

namespace {
std::mutex& mutex() {
  static std::mutex m;
  return m;
}
std::shared_ptr<MainThreadScheduler>& instance() {
  static std::shared_ptr<MainThreadScheduler> s;
  return s;
}
std::function<std::shared_ptr<MainThreadScheduler>()>& factory() {
  static std::function<std::shared_ptr<MainThreadScheduler>()> f;
  return f;
}
} // namespace

void setMainThreadScheduler(std::shared_ptr<MainThreadScheduler> scheduler) {
  std::lock_guard<std::mutex> lock(mutex());
  instance() = std::move(scheduler);
}

void setMainThreadSchedulerFactory(
    std::function<std::shared_ptr<MainThreadScheduler>()> f) {
  std::lock_guard<std::mutex> lock(mutex());
  factory() = std::move(f);
}

std::shared_ptr<MainThreadScheduler> getMainThreadScheduler() {
  std::lock_guard<std::mutex> lock(mutex());
  if (!instance() && factory()) {
    // Build lazily, on this thread (JNI-attached on Android). Runs at most once:
    // clearing the factory afterwards means a construction that returns null is
    // not retried, and a successful one is cached in instance().
    auto f = factory();
    factory() = nullptr;
    instance() = f();
  }
  return instance();
}

} // namespace facebook::react::workers
