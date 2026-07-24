#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "WorkerRuntimeHost.h"

namespace facebook::react::workers {

// Owns a second Hermes runtime on a dedicated thread and drives a minimal
// HTML-spec-shaped event loop (macrotasks + microtask checkpoints + timers).
// This is the "Option B" runtime host — no RN ReactInstance dependency, which is
// what lets it link from a library on both iOS and Android (see Phase 0/1 docs).
class HermesWorkerHost : public WorkerRuntimeHost {
 public:
  using Task = WorkerRuntimeHost::Task;
  using InstallFn = WorkerRuntimeHost::InstallFn;

  HermesWorkerHost(std::string name, uint32_t maxHeapMb);
  ~HermesWorkerHost() override;

  HermesWorkerHost(const HermesWorkerHost&) = delete;
  HermesWorkerHost& operator=(const HermesWorkerHost&) = delete;

  // Starts the thread, creates the runtime, runs `install` (bindings), evaluates
  // `prelude` then `code`. Uncaught errors (eval, tasks, timers) are routed
  // through the JS prelude's __rnworkersReportError -> parent onerror.
  void start(
      std::string prelude,
      std::string code,
      std::string sourceUrl,
      InstallFn install) override;

  // Post a task to the worker JS thread. Tasks posted before the bundle finishes
  // evaluating are queued and run afterwards (browser semantics).
  void post(Task&& task) override;

  // A CallInvoker bound to this worker's thread (for TurboModules — Phase 3).
  std::shared_ptr<CallInvoker> callInvoker() override;

  // Run cleanup on the worker thread before the runtime is destroyed (see
  // WorkerRuntimeHost::setPreDestroy).
  void setPreDestroy(std::function<void(jsi::Runtime&)> fn) override {
    preDestroy_ = std::move(fn);
  }

  // Timer management — called ON the worker thread (from host functions).
  uint32_t addTimer(std::shared_ptr<jsi::Function> cb, double ms, bool repeat)
      override;
  void clearTimer(uint32_t id) override;

  // graceful: finish queued work then exit; immediate: drop and exit ASAP.
  void requestShutdown(bool immediate) override;

 private:
  class InertInvoker;
  // Shared control block between the host and its CallInvoker(s); `host` is
  // nulled on destruction so late callbacks become no-ops.
  struct InvokerShared {
    std::mutex mutex;
    HermesWorkerHost* host = nullptr;
  };

  struct Timer {
    uint32_t id;
    std::chrono::steady_clock::time_point deadline;
    double intervalMs;
    bool repeat;
    std::shared_ptr<jsi::Function> cb;
  };

  void threadMain(
      std::string prelude,
      std::string code,
      std::string sourceUrl,
      InstallFn install);
  void runDueTimers(jsi::Runtime& rt);
  bool hasWork() const; // caller holds mutex_

  const std::string name_;
  const uint32_t maxHeapMb_;

  std::thread thread_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Task> tasks_;
  bool stop_ = false;
  bool immediate_ = false;

  // Worker-thread-only state (no lock needed):
  std::vector<Timer> timers_;
  uint32_t nextTimerId_ = 1;

  std::shared_ptr<InvokerShared> invokerShared_;

  // Set on the worker thread during install; invoked (once) on the worker thread
  // right before the runtime is destroyed. Worker-thread-only; no lock needed.
  std::function<void(jsi::Runtime&)> preDestroy_;
};

} // namespace facebook::react::workers
