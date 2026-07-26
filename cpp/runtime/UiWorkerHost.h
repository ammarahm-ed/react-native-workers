#pragma once

#include <jsi/jsi.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>

#include "MainThreadScheduler.h"
#include "WorkerInspector.h"
#include "WorkerRuntimeHost.h"

namespace facebook::react::workers {

// A worker whose Hermes runtime lives on the platform main/UI thread, driven
// reactively by the MainThreadScheduler (no blocking loop — it would freeze the
// UI). Lets worker JS call UI-affine native methods directly. Non-spec; used by
// UIWorker. The runtime + timers live in a shared state that is only ever
// touched on the main thread, so teardown from any thread stays safe.
class UiWorkerHost : public WorkerRuntimeHost {
 public:
  UiWorkerHost(
      std::string name,
      uint32_t maxHeapMb,
      std::shared_ptr<MainThreadScheduler> scheduler,
      bool inspectable = false);
  ~UiWorkerHost() override;

  void start(
      std::string prelude,
      std::string code,
      std::string sourceUrl,
      InstallFn install) override;
  void post(Task&& task) override;
  std::shared_ptr<CallInvoker> callInvoker() override;
  void setPreDestroy(std::function<void(jsi::Runtime&)> fn) override {
    // Install runs on the main thread, where state_ is exclusively touched.
    state_->preDestroy = std::move(fn);
  }
  uint32_t addTimer(std::shared_ptr<jsi::Function> cb, double ms, bool repeat)
      override;
  void clearTimer(uint32_t id) override;
  void requestShutdown(bool immediate) override;

 private:
  struct TimerState {
    std::shared_ptr<jsi::Function> cb;
    double intervalMs = 0;
    bool repeat = false;
    std::shared_ptr<std::atomic<bool>> alive;
  };

  // Everything the runtime touches lives here; mutated only on the main thread.
  struct State {
    std::unique_ptr<jsi::Runtime> runtime;
    std::atomic<bool> stopped{false};
    std::unordered_map<uint32_t, std::shared_ptr<TimerState>> timers;
    uint32_t nextTimerId = 1;
    uint32_t maxHeapMb = 256;
    std::shared_ptr<MainThreadScheduler> scheduler;
    // Runs on the main thread with the runtime alive, before it's destroyed.
    std::function<void(jsi::Runtime&)> preDestroy;
    // The debugger target, when this UIWorker opted into `inspectable`. Held for
    // the runtime's lifetime (there is no blocking run loop to own it) and torn
    // down on the main thread before the runtime. Null when not inspectable or in
    // release.
    std::unique_ptr<WorkerInspectorTarget> inspectorTarget;
  };

  // Static on purpose: the delayed lambda outlives `this` when the host is
  // reaped off-thread, so rescheduling must go through the shared State only.
  static void scheduleTimer(
      std::shared_ptr<State> state,
      uint32_t id,
      std::shared_ptr<TimerState> ts);

  std::string name_;
  std::shared_ptr<MainThreadScheduler> scheduler_;
  bool inspectable_;
  std::shared_ptr<State> state_;
};

} // namespace facebook::react::workers
