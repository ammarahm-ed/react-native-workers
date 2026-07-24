#pragma once

#include <jsi/jsi.h>

#include <functional>
#include <string>

namespace facebook::react::workers {

// Schedules a callback onto a specific runtime's thread (host CallInvoker or a
// worker's event loop). Used to deliver change notifications on the right thread.
using RuntimePoster = std::function<void(std::function<void(jsi::Runtime&)>)>;

// Installs the non-spec `SharedStore` primitive into `rt`:
//
//   const store = new SharedStore('name');   // JS wrapper over __rnworkersOpenStore
//   store.set('k', {any: 'structured value'}); // synchronized write (mutex)
//   const v = store.get('k');                  // synchronized read
//   const off = store.subscribe('k', (v) => …);// async watcher, fires on change
//
// A named store is a single C++-owned, mutex-guarded map shared by every runtime
// (host + all workers). Values are held as encoded Messages (runtime-neutral) and
// decoded into whichever runtime reads them. `poster` runs this runtime's
// subscription callbacks on its own thread.
//
// Returns a cleanup function that removes every subscription this runtime created
// (across all stores) and destroys their callbacks. It MUST be called on the
// runtime's own thread while the runtime is still alive — right before teardown —
// so that a store `set`/`delete` from another runtime can no longer reach a
// destroyed worker, and the `jsi::Function` callbacks are freed against a live
// runtime. The host runtime (which never tears down) can ignore it.
std::function<void(jsi::Runtime&)> installSharedStore(
    jsi::Runtime& rt,
    RuntimePoster poster);

} // namespace facebook::react::workers
