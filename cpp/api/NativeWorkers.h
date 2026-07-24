#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace facebook::react::workers {

// Receives events from a natively-created worker. Callbacks run on the WORKER
// thread — dispatch to your own thread (e.g. the UI thread) as needed.
class NativeWorkerDelegate {
 public:
  virtual ~NativeWorkerDelegate() = default;
  virtual void onMessage(const std::string& json) = 0;
  virtual void onError(const std::string& message) = 0;
};

// A thread-safe facade for creating and driving workers directly from native
// code — from ANY thread, including the UI thread, and independent of the app's
// JS runtime. Messages cross the boundary as JSON strings.
//
// Example (from a TurboModule or a UI-thread event handler):
//   auto id = NativeWorkers::create(jsCode, myDelegate, "bg");
//   NativeWorkers::postMessage(id, R"({"cmd":"query"})");
//   ...
//   NativeWorkers::terminate(id);
class NativeWorkers {
 public:
  static uint32_t create(
      const std::string& code,
      std::shared_ptr<NativeWorkerDelegate> delegate,
      const std::string& name = "");
  static void postMessage(uint32_t id, const std::string& json);
  static void terminate(uint32_t id);
};

} // namespace facebook::react::workers
