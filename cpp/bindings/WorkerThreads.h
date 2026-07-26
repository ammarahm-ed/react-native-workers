#pragma once

#include <jsi/jsi.h>

#include <functional>
#include <memory>

#include "../runtime/WorkerJsLock.h"

namespace facebook::react::workers {

// Installs the host functions behind the experimental `Thread` API, which runs
// this worker's JS on another thread — the platform main thread, or a serial
// background thread — without moving the runtime or creating a second one.
//
// The whole feature is gated: until JS calls
// `global.enableMultiThreadingExperimental()`, every entry point throws. The
// WorkerJsScope machinery is always active regardless (it costs an uncontended
// recursive mutex per JS task), so enabling is purely about opening the door,
// never about switching on the protection.
//
// `postToOwner` schedules work back onto the worker's OWN thread — its
// CallInvoker, not the raw host, so it goes inert when the worker is torn down.
// Promise settlement always goes through it, which is what keeps `await` from
// silently resuming your code on a foreign thread.
//
// Returns a teardown thunk that disposes every target this worker created. It
// must run on the worker thread inside a WorkerJsScope (setPreDestroy does).
std::function<void()> installWorkerThreads(
    jsi::Runtime& rt,
    std::shared_ptr<WorkerRuntimeLock> lock,
    std::function<void(std::function<void(jsi::Runtime&)>)> postToOwner);

} // namespace facebook::react::workers
