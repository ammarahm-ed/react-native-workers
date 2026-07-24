#pragma once

#include <functional>
#include <memory>
#include <string>

namespace facebook::hermes {
class HermesRuntime;
}

namespace facebook::react::workers {

// Exposes a worker's Hermes runtime to the debugger as its own inspectable
// target, so DevTools lists it alongside the app's main runtime and can set
// breakpoints, step, and show its console output.
//
// Why a separate target rather than folding workers into the app's target: a
// worker is a genuinely independent runtime on its own thread with its own call
// stack and scope chain. CDP's model is one target per runtime; merging them
// would make "pause" and "step" ambiguous. RN's own HostTarget/InstanceTarget
// tree is built around the host's instance lifecycle, which a worker does not
// participate in — so we register through the lower-level IInspector::addPage
// API, the same seam RN's own target registers through.
//
// Nothing here is compiled into a release build's hot path: registration is
// skipped entirely when the inspector is disabled.
class WorkerInspectorTarget {
 public:
  virtual ~WorkerInspectorTarget() = default;
};

// Posts a task onto the worker's JS thread. Debugger commands arrive on the
// packager's socket thread and must be executed on the runtime's own thread.
using WorkerTaskPoster = std::function<void(std::function<void()>)>;

// Registers `runtime` as a debuggable target named `title`.
//
// Must be called ON the worker thread, after the runtime exists and before user
// code runs (so early breakpoints are not missed). The returned handle removes
// the target when destroyed; destroy it on the worker thread while the runtime
// is still alive.
//
// Returns nullptr when the inspector is disabled or unavailable, which is the
// normal case in release builds — callers should treat that as success.
std::unique_ptr<WorkerInspectorTarget> registerWorkerInspectorTarget(
    const std::string& title,
    facebook::hermes::HermesRuntime& runtime,
    WorkerTaskPoster poster);

} // namespace facebook::react::workers
