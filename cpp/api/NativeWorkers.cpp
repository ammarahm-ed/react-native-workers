#include "NativeWorkers.h"

#include "../core/MessageCodec.h"
#include "../core/Worker.h"

#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>

namespace facebook::react::workers {

namespace {

void reap(std::shared_ptr<Worker> w) {
  if (!w) return;
  std::thread([w = std::move(w)]() mutable { w.reset(); }).detach();
}

// Owns all natively-created workers and routes their events to delegates.
class Registry : public HostDelivery {
 public:
  static Registry& get() {
    static Registry* instance = new Registry();
    return *instance;
  }

  uint32_t create(
      const std::string& code,
      std::shared_ptr<NativeWorkerDelegate> delegate,
      const std::string& name) {
    std::shared_ptr<Worker> worker;
    uint32_t id;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      id = nextId_++;
      delegates_[id] = std::move(delegate);
      worker = std::make_shared<Worker>(id, name, 256, this);
      workers_[id] = worker;
    }
    worker->start(code, "worker://native");
    return id;
  }

  void post(uint32_t id, const std::string& json) {
    std::shared_ptr<Worker> worker;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto it = workers_.find(id);
      if (it != workers_.end()) worker = it->second;
    }
    if (worker) worker->deliverJsonToWorker(json);
  }

  void terminate(uint32_t id) {
    std::shared_ptr<Worker> worker = detach(id);
    if (worker) {
      worker->terminate();
      reap(worker);
    }
  }

  void deliverMessage(uint32_t id, Message message) override {
    auto d = findDelegate(id);
    if (d) d->onMessage(messageToJson(message));
  }
  void deliverError(uint32_t id, WorkerError error) override {
    auto d = findDelegate(id);
    if (d) d->onError(error.message);
  }
  void workerClosed(uint32_t id) override {
    reap(detach(id));
  }

 private:
  std::shared_ptr<NativeWorkerDelegate> findDelegate(uint32_t id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = delegates_.find(id);
    return it != delegates_.end() ? it->second : nullptr;
  }
  std::shared_ptr<Worker> detach(uint32_t id) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::shared_ptr<Worker> worker;
    auto it = workers_.find(id);
    if (it != workers_.end()) {
      worker = it->second;
      workers_.erase(it);
    }
    delegates_.erase(id);
    return worker;
  }

  std::mutex mutex_;
  std::unordered_map<uint32_t, std::shared_ptr<Worker>> workers_;
  std::unordered_map<uint32_t, std::shared_ptr<NativeWorkerDelegate>> delegates_;
  uint32_t nextId_ = 1;
};

} // namespace

uint32_t NativeWorkers::create(
    const std::string& code,
    std::shared_ptr<NativeWorkerDelegate> delegate,
    const std::string& name) {
  return Registry::get().create(code, std::move(delegate), name);
}

void NativeWorkers::postMessage(uint32_t id, const std::string& json) {
  Registry::get().post(id, json);
}

void NativeWorkers::terminate(uint32_t id) {
  Registry::get().terminate(id);
}

} // namespace facebook::react::workers
