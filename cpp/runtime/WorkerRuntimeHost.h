#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "WorkerJsLock.h"

namespace facebook::react::workers {

// Abstract host that owns a worker's Hermes runtime and drives its event loop.
// Two implementations: HermesWorkerHost (dedicated background thread, spec
// Worker) and UiWorkerHost (runs on the platform main/UI thread, for UIWorker).
class WorkerRuntimeHost {
 public:
  using Task = std::function<void(jsi::Runtime&)>;
  using InstallFn = std::function<void(jsi::Runtime&)>;

  virtual ~WorkerRuntimeHost() = default;

  virtual void start(
      std::string prelude,
      std::string code,
      std::string sourceUrl,
      InstallFn install) = 0;
  virtual void post(Task&& task) = 0;
  virtual std::shared_ptr<CallInvoker> callInvoker() = 0;
  // The lock every entry into this worker's runtime must be taken under. Valid
  // from construction (before the runtime exists), so it is safe to hand to
  // another thread at any time — see WorkerJsLock.h.
  virtual std::shared_ptr<WorkerRuntimeLock> runtimeLock() = 0;
  // Register a callback run ON the worker thread with the runtime STILL ALIVE,
  // just before the runtime is destroyed. Used to tear down a per-worker platform
  // TurboModule manager (invalidate its modules) while its jsi references are
  // still valid — doing it after the runtime is gone crashes. The callback also
  // owns the manager for the worker's lifetime (it captures it).
  virtual void setPreDestroy(std::function<void(jsi::Runtime&)> fn) = 0;
  virtual uint32_t addTimer(
      std::shared_ptr<jsi::Function> cb,
      double ms,
      bool repeat) = 0;
  virtual void clearTimer(uint32_t id) = 0;
  virtual void requestShutdown(bool immediate) = 0;
};

} // namespace facebook::react::workers
