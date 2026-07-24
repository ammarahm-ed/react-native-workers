#pragma once

#include <jsi/jsi.h>

#include "../core/WorkerTypes.h"

namespace facebook::react::workers {

// Installs the low-level host functions (__workerPostMessage, __workerClose,
// __workerLog, __workerReportError, __workerSetTimer, __workerClearTimer) and
// __rnworkersSourceURL into the worker runtime's global. The JS prelude
// (WorkerPrelude.h) builds the spec-shaped WorkerGlobalScope on top of these.
// Must be called on the worker thread before evaluating the prelude.
void installWorkerGlobalScope(jsi::Runtime& rt, WorkerHooks hooks);

// Installs a spec-shaped `structuredClone` global (same-runtime clone). Usable in
// both the host and worker runtimes.
void installStructuredClone(jsi::Runtime& rt);

} // namespace facebook::react::workers
