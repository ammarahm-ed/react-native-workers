#pragma once

#include <jsi/jsi.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "MessageCodec.h"

namespace facebook::react::workers {

// Uncaught error surfaced from a worker to the parent's `onerror`.
struct WorkerError {
  std::string message;
  std::string filename;
  int lineno = 0;
  int colno = 0;
  std::string stack;
};

// How the source of a worker is provided to native.
struct WorkerSource {
  std::string kind; // "inline" | "url" | "asset"
  std::string value; // code / URL / asset path
  std::string sourceUrl;
};

// Implemented by the host module; lets a Worker deliver events back to the host
// JS runtime. Implementations MUST be safe to call from the worker thread
// (they hop onto the host JS thread via the host CallInvoker).
class HostDelivery {
 public:
  virtual ~HostDelivery() = default;
  virtual void deliverMessage(uint32_t workerId, Message message) = 0;
  virtual void deliverError(uint32_t workerId, WorkerError error) = 0;
  virtual void workerClosed(uint32_t workerId) = 0;
  // The worker registered a NativeEventEmitter listener; the host should start
  // forwarding host device events (from Java/ObjC modules) to it. Default no-op
  // so alternative deliveries (e.g. the native C++ API) need not implement it.
  virtual void enableDeviceEvents(uint32_t /*workerId*/) {}
  // A console call inside the worker. Forwarded to the host so worker output
  // appears alongside app logs (Metro, DevTools) rather than only in the
  // platform log. Default no-op for deliveries with no JS host to log to.
  virtual void
  deliverLog(uint32_t /*workerId*/, const std::string& /*level*/, const std::string& /*text*/) {}
};

// Callbacks the WorkerGlobalScope host functions invoke (all on the worker
// thread). Wired by Worker to the HermesWorkerHost + HostDelivery.
struct WorkerHooks {
  // self.postMessage(value, transfer) — value already encoded on worker rt.
  std::function<void(Message)> onPostMessage;
  // self.close()
  std::function<void()> onClose;
  // console.* -> (level, text)
  std::function<void(const std::string&, const std::string&)> onLog;
  // uncaught error routed to parent onerror
  std::function<void(WorkerError)> onReportError;
  // setTimeout/setInterval -> returns timer id
  std::function<uint32_t(std::shared_ptr<jsi::Function>, double ms, bool repeat)>
      onSetTimer;
  std::function<void(uint32_t)> onClearTimer;
  // First NativeEventEmitter listener in this worker -> ask host to forward
  // host-originated device events here.
  std::function<void()> onEnableDeviceEvents;
  std::string sourceUrl;
};

} // namespace facebook::react::workers
