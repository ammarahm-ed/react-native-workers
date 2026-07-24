#pragma once

#include <ReactCommon/CallInvoker.h>

#include <cstdint>
#include <memory>
#include <string>

#include "WorkerTypes.h"
#include "../runtime/WorkerRuntimeHost.h"

namespace facebook::react::workers {

// One worker: owns a runtime host (background thread by default, or the UI
// thread when `ui` is set) and bridges its WorkerGlobalScope hooks to the
// host-side HostDelivery.
class Worker {
 public:
  Worker(
      uint32_t id,
      std::string name,
      uint32_t maxHeapMb,
      HostDelivery* delivery,
      bool ui = false,
      bool nativeModules = false,
      bool inspectable = false);
  ~Worker();

  Worker(const Worker&) = delete;
  Worker& operator=(const Worker&) = delete;

  // Start from an inline code string (Phase 1) or already-loaded bundle code.
  void start(std::string code, std::string sourceUrl);

  // Host -> worker message (encoded from the host runtime).
  void deliverToWorker(Message message);

  // Host -> worker device event: calls the worker's __rctDeviceEventEmitter with
  // the decoded [type, ...args]. Shared encoded copy across workers.
  void deliverDeviceEvent(std::shared_ptr<Message> eventArgs);

  // Native -> worker message as a JSON string (for the native/UI-thread API).
  void deliverJsonToWorker(std::string json);

  void terminate();

  std::shared_ptr<CallInvoker> callInvoker() { return host_->callInvoker(); }

  uint32_t id() const { return id_; }

 private:
  WorkerHooks makeHooks(const std::string& sourceUrl);

  uint32_t id_;
  std::string name_;
  uint32_t maxHeapMb_;
  HostDelivery* delivery_;
  bool ui_;
  bool nativeModules_;
  bool inspectable_;
  std::unique_ptr<WorkerRuntimeHost> host_;
};

} // namespace facebook::react::workers
