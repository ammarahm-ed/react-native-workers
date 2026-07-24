#pragma once

#include <jsi/jsi.h>

namespace facebook::react::workers {

// Installs the `SharedBuffer` primitive into `rt`:
//
//   const buf = new SharedBuffer('pixels', 1024 * 8);
//   const view = new Float64Array(buf.arrayBuffer);  // same memory in EVERY runtime
//   view[i] = …;                                     // full-speed JS, zero host calls
//   buf.withLock(() => { … });                       // cross-runtime critical section
//
// A named SharedBuffer is one process-global byte buffer. Each runtime that opens
// it gets a jsi `ArrayBuffer` backed by the SAME native memory (via a shared
// `MutableBuffer`), so typed-array views in different runtimes read/write the same
// bytes — true zero-copy shared memory, without JS `SharedArrayBuffer` (which
// Hermes lacks). It is RAW memory: concurrent overlapping writes race, so pair it
// with `withLock` or a single-writer discipline. No synchronization is implicit.
//
// Installs `__rnworkersOpenSharedBuffer(name, byteLength)` and
// `__rnworkersOpenSharedLock(name)`. No teardown cleanup needed (no callbacks).
void installSharedBuffer(jsi::Runtime& rt);

} // namespace facebook::react::workers
