#pragma once

#include <jsi/jsi.h>

namespace facebook::react::workers {

/**
 * Installs a worker-safe `__blobCollectorProvider` onto `rt`.
 *
 * Called after the worker's TurboModule proxy is in place, so that
 * `BlobManager.createBlobCollector` (Libraries/Blob/BlobManager.js) can free
 * native blob data when a JS `Blob` is collected. See the .cpp for why RN's own
 * Android provider cannot be used inside a worker.
 */
void installWorkerBlobCollector(facebook::jsi::Runtime& rt);

} // namespace facebook::react::workers
