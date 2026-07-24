#include "WorkerInspector.h"

#include <hermes/RuntimeTaskRunner.h>
#include <hermes/cdp/CDPAgent.h>
#include <hermes/cdp/CDPDebugAPI.h>
#include <hermes/hermes.h>
#include <jsinspector-modern/InspectorFlags.h>
#include <jsinspector-modern/InspectorInterfaces.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <utility>

namespace facebook::react::workers {

namespace {

using facebook::hermes::cdp::CDPAgent;
using facebook::hermes::cdp::CDPDebugAPI;
using facebook::react::jsinspector_modern::ILocalConnection;
using facebook::react::jsinspector_modern::IRemoteConnection;

// Execution context id for a worker's runtime. Each target has its own CDP
// world, so a fixed id per target is fine — it only has to be stable within
// this target, not unique across targets.
constexpr int32_t kWorkerExecutionContextId = 1;

// One live debugger session against one worker.
//
// Threading: sendMessage/disconnect are called on the packager's socket thread,
// while the CDPAgent must be driven on the runtime's thread. CDPAgent is
// explicitly documented as safe to construct/destroy/handleCommand from
// arbitrary threads (it internally enqueues runtime work via the task func we
// supply), so the only thing we must guarantee is that the task poster actually
// lands work on the worker's JS thread.
class WorkerLocalConnection : public ILocalConnection {
 public:
  WorkerLocalConnection(
      CDPDebugAPI& debugAPI,
      facebook::hermes::HermesRuntime& runtime,
      WorkerTaskPoster poster,
      std::unique_ptr<IRemoteConnection> remote)
      : remote_(std::move(remote)) {
    auto* remotePtr = remote_.get();
    auto* runtimePtr = &runtime;
    agent_ = CDPAgent::create(
        kWorkerExecutionContextId,
        debugAPI,
        // Runtime tasks must run on the worker's JS thread, and each one is
        // handed the runtime it belongs to. Capturing the runtime by pointer is
        // safe because the target — and therefore this connection — is torn
        // down on the worker thread while the runtime is still alive.
        [poster, runtimePtr](facebook::hermes::debugger::RuntimeTask task) {
          poster([task = std::move(task), runtimePtr]() mutable {
            task(*runtimePtr);
          });
        },
        // Outbound CDP messages go straight back to the client.
        [remotePtr](const std::string& message) {
          remotePtr->onMessage(message);
        });
  }

  ~WorkerLocalConnection() override = default;

  void sendMessage(std::string message) override {
    if (agent_) {
      agent_->handleCommand(std::move(message));
    }
  }

  void disconnect() override {
    // Destroying the agent may enqueue final runtime tasks; the worker loop is
    // still running at this point and will drain them.
    agent_.reset();
    if (remote_) {
      remote_->onDisconnect();
      remote_.reset();
    }
  }

 private:
  std::unique_ptr<IRemoteConnection> remote_;
  std::unique_ptr<CDPAgent> agent_;
};

class HermesWorkerInspectorTarget : public WorkerInspectorTarget {
 public:
  HermesWorkerInspectorTarget(
      std::unique_ptr<CDPDebugAPI> debugAPI,
      int pageId)
      : debugAPI_(std::move(debugAPI)), pageId_(pageId) {}

  ~HermesWorkerInspectorTarget() override {
    // Remove first: this closes any live session (the inspector calls
    // disconnect() on the local connection), so no CDP work can be in flight
    // against debugAPI_ by the time we destroy it.
    jsinspector_modern::getInspectorInstance().removePage(pageId_);
    debugAPI_.reset();
  }

 private:
  std::unique_ptr<CDPDebugAPI> debugAPI_;
  int pageId_;
};

} // namespace

std::unique_ptr<WorkerInspectorTarget> registerWorkerInspectorTarget(
    const std::string& title,
    facebook::hermes::HermesRuntime& runtime,
    WorkerTaskPoster poster) {
  // In a release build (or with the debugger disabled) there is nothing to
  // attach to, and creating a CDPDebugAPI would cost memory for no reason.
  auto& flags = jsinspector_modern::InspectorFlags::getInstance();
  if (!flags.getFuseboxEnabled()) {
    return nullptr;
  }

  auto debugAPI = CDPDebugAPI::create(runtime);
  auto* debugAPIPtr = debugAPI.get();
  auto* runtimePtr = &runtime;

  int pageId = jsinspector_modern::getInspectorInstance().addPage(
      title,
      "Hermes",
      [debugAPIPtr, runtimePtr, poster](std::unique_ptr<IRemoteConnection> remote)
          -> std::unique_ptr<ILocalConnection> {
        if (!remote) {
          return nullptr;
        }
        return std::make_unique<WorkerLocalConnection>(
            *debugAPIPtr, *runtimePtr, poster, std::move(remote));
      },
      // Without these the modern (Fusebox) frontend skips the target entirely —
      // it is listed by /json/list but never offered as a debuggable page
      // ("Ignoring DevTools app debug target ... nativePageReloads set to
      // 'false'"). A worker survives a JS reload of the host and serves its own
      // sources over CDP, so both capabilities hold.
      jsinspector_modern::InspectorTargetCapabilities{
          .nativePageReloads = true,
          .nativeSourceCodeFetching = false,
      });

  return std::make_unique<HermesWorkerInspectorTarget>(
      std::move(debugAPI), pageId);
}

} // namespace facebook::react::workers
