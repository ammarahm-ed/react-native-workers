#pragma once

#include <jsi/jsi.h>

#include <functional>

#include "SharedStore.h" // RuntimePoster

namespace facebook::react::workers {

// Installs the `SharedValue` primitive into `rt`:
//
//   const sv = new SharedValue('name', 0);
//   sv.value = 0.42;          // synchronous write (lock-free for numbers)
//   const x = sv.value;       // synchronous read
//   const off = sv.subscribe(v => …);  // optional change notification
//
// A named SharedValue is a single process-global cell shared by every runtime.
// Unlike SharedStore it has no key/map/tree on the access path — reads/writes are
// one HostObject access + (for numbers) a lock-free atomic op, so it matches the
// cost model of a Reanimated shared value. Non-number values go through the codec
// under a lightweight lock. Writes notify subscribers only when there are any.
//
// Returns a cleanup that removes this runtime's subscriptions; run it on the
// runtime's own thread before teardown (same contract as installSharedStore).
std::function<void(jsi::Runtime&)> installSharedValue(
    jsi::Runtime& rt,
    RuntimePoster poster);

} // namespace facebook::react::workers
