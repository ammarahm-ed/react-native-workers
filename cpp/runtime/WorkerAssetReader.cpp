#include "WorkerAssetReader.h"

#include <mutex>

namespace facebook::react::workers {

namespace {
std::mutex& mutex() {
  static std::mutex m;
  return m;
}
std::shared_ptr<WorkerAssetReader>& instance() {
  static std::shared_ptr<WorkerAssetReader> r;
  return r;
}
std::function<std::shared_ptr<WorkerAssetReader>()>& factory() {
  static std::function<std::shared_ptr<WorkerAssetReader>()> f;
  return f;
}
} // namespace

void setWorkerAssetReader(std::shared_ptr<WorkerAssetReader> reader) {
  std::lock_guard<std::mutex> lock(mutex());
  instance() = std::move(reader);
}

void setWorkerAssetReaderFactory(
    std::function<std::shared_ptr<WorkerAssetReader>()> f) {
  std::lock_guard<std::mutex> lock(mutex());
  factory() = std::move(f);
}

std::shared_ptr<WorkerAssetReader> getWorkerAssetReader() {
  std::lock_guard<std::mutex> lock(mutex());
  if (!instance() && factory()) {
    // Same contract as the main-thread scheduler: build once, on this thread
    // (JNI-attached on Android), and do not retry a factory that returned null.
    auto f = factory();
    factory() = nullptr;
    instance() = f();
  }
  return instance();
}

} // namespace facebook::react::workers
