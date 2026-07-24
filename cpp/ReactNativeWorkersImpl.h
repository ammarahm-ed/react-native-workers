#pragma once

#include <ReactNativeWorkersSpecJSI.h>

#include <react/bridging/Promise.h>

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "core/Worker.h"
#include "core/WorkerTypes.h"

namespace facebook::react {

class ReactNativeWorkersImpl
    : public NativeReactNativeWorkersCxxSpec<ReactNativeWorkersImpl>,
      public workers::HostDelivery {
 public:
  ReactNativeWorkersImpl(std::shared_ptr<CallInvoker> jsInvoker);
  ~ReactNativeWorkersImpl() override;

  double multiply(jsi::Runtime& rt, double a, double b);

  // Installs the JSI globals (__RNWorkersPostMessage) used by the JS Worker.
  bool install(jsi::Runtime& rt);
  // kind: "inline" | "url" | "asset". Returns the worker id. `nativeModules`
  // opts into the per-worker platform (Java/ObjC) TurboModule manager.
  double createWorker(
      jsi::Runtime& rt,
      std::string kind,
      std::string value,
      std::string sourceUrl,
      std::string name,
      bool nativeModules);
  double createUIWorker(
      jsi::Runtime& rt,
      std::string kind,
      std::string value,
      std::string sourceUrl,
      std::string name,
      bool nativeModules,
      bool independent,
      bool inspectable);
  void terminate(jsi::Runtime& rt, double id);
  void terminateUIWorkerRuntime(jsi::Runtime& rt, std::string sourceUrl);
  AsyncPromise<std::string> nativeWorkerSelfTest(jsi::Runtime& rt);

  // HostDelivery (called from worker threads; hop to host JS thread).
  void deliverMessage(uint32_t workerId, workers::Message message) override;
  void deliverError(uint32_t workerId, workers::WorkerError error) override;
  void deliverLog(
      uint32_t workerId,
      const std::string& level,
      const std::string& text) override;
  void workerClosed(uint32_t workerId) override;
  void enableDeviceEvents(uint32_t workerId) override;

 private:
  double createWorkerImpl(
      std::string kind,
      std::string value,
      std::string sourceUrl,
      std::string name,
      bool ui,
      bool nativeModules,
      bool shared,
      bool inspectable);

  // Wraps global.__rctDeviceEventEmitter.emit so host-originated device events
  // (incl. from Java/ObjC modules) are forwarded to workers that opted in.
  void installDeviceEventBridge(jsi::Runtime& rt);

  // Reap a runtime and detach every connection on it. Host JS thread only.
  void reapRuntime(uint32_t runtimeId);

  // --- Runtime + connection registry (all touched only on the host JS thread) ---
  //
  // A "runtime" is one Hermes runtime (a `Worker`). A "connection" is one JS-side
  // handle. Background workers and `independent` UIWorkers are 1:1 (one
  // connection == one runtime). Shared UIWorkers are 1:N: many connections route
  // to one persistent runtime keyed by source URL, and worker->host deliveries
  // fan out to all of them.

  // Every runtime by its id (the runtime's own `Worker::id()`), private + shared.
  std::unordered_map<uint32_t, std::shared_ptr<workers::Worker>> runtimes_;
  // runtimeId -> the connection ids currently attached (fan-out targets).
  std::unordered_map<uint32_t, std::vector<uint32_t>> runtimeConnections_;
  // connectionId -> its runtimeId (message routing + terminate).
  std::unordered_map<uint32_t, uint32_t> connRuntime_;
  // Shared UIWorker runtimes only: sourceUrl -> runtimeId (dedup + teardown).
  std::unordered_map<std::string, uint32_t> uiRuntimes_;
  // Shared UIWorker runtimes only: runtimeId -> sourceUrl (marks a runtime shared).
  std::unordered_map<uint32_t, std::string> runtimeUrl_;
  // Runtimes with >=1 NativeEventEmitter listener; only these get forwarded
  // device events (once per runtime, not per connection).
  std::unordered_set<uint32_t> deviceEventRuntimes_;
  uint32_t nextId_ = 1;
};

} // namespace facebook::react
