---
sidebar_position: 9
title: How it works
---

# How it works

A high-level tour of what happens under the hood. You don't need any of this to use
the library, but it helps to understand the trade-offs.

## A worker is a second Hermes runtime

When you create a `Worker`, the library spins up a **new Hermes runtime on a
dedicated OS thread** and drives a minimal, HTML-spec-shaped event loop on it
(macrotasks + microtask checkpoints + timers). It is *not* a second React Native
instance — just a runtime plus the worker environment (`self`, `postMessage`,
timers, and the library's globals), which is what lets it link from a library on
both iOS and Android.

`UIWorker` is the same idea, but the runtime is driven on the platform **main
thread** instead of a background thread.

## Messaging

Values are serialized with a **flat binary codec**: one contiguous buffer for the
structured data plus out-of-band "blobs" for binary payloads. Binary data is copied
at most once on encode and handed to the receiving runtime **zero-copy** on decode
(the `ArrayBuffer` points at the shared native bytes). Messages are posted to the
target runtime's loop and delivered in order.

## SharedStore: an immutable node tree

A `SharedStore` value is not a flat blob — it's an **immutable, structurally-shared
tree of nodes**:

- a **leaf** holds a primitive *inline* (numbers/booleans/strings/null — no codec)
  or, for typed arrays / `Date` / `ArrayBuffer`, an encoded message;
- an **object** node is a map of child nodes; an **array** node is a vector of them.

This is what makes reads lazy and writes granular:

- **`get`** returns a proxy over the tree; only the leaves you touch are decoded.
- **`setIn`** encodes just the new value and copy-on-write rebuilds only the path
  from the root to that field — every untouched subtree is pointer-shared. Cost is
  O(depth), independent of the total value size.

Inline scalar leaves are what keep the tree fast even for large arrays, so it
matches or beats a single flat blob while staying granularly addressable.

## SharedValue: an atomic cell

A `SharedValue` is one process-global cell. Numbers live in a lock-free
`std::atomic<double>`; anything else is an encoded message under a light mutex. No
key, no map, no tree — a `.value` access is one host call plus (for numbers) an
atomic load/store. An atomic "has subscribers" flag keeps no-watcher number writes
fully lock-free.

## SharedBuffer: one buffer, many views

A `SharedBuffer` owns a block of native bytes. Each runtime that opens the name gets
an `ArrayBuffer` backed by the **same** native memory, so typed-array views alias
the same bytes. This gives shared-memory semantics without JavaScript's
`SharedArrayBuffer` (which Hermes lacks). Synchronization is your responsibility —
`withLock` provides a named, cross-runtime recursive mutex.

## The bridge & defineModule

The JSModule bridge is a thin JS layer over the message channel. Each side keeps a
registry of local modules and a map of outstanding calls keyed by a correlation id.
A call serializes `(module, method, args)`, posts it, and the other side invokes the
method and posts the result back — resolving the caller's promise. Events are
one-way. Bridge traffic is multiplexed alongside your own `postMessage` traffic
(tagged internally) and intercepted before it reaches your `onmessage`.

`defineModule` is pure sugar over that bridge plus `reactive` state — it desugars to
`JSModule` / `registerModule` / `parent.module` / `SharedStore`.

## Native modules in workers

- **C++ (Cxx) TurboModules** resolve from the process-global CxxTurboModule map,
  bound to the worker's CallInvoker.
- **iOS platform modules**: a per-worker `RCTTurboModuleManager` with a generic
  delegate resolves any registered class from the global registry.
- **Android platform modules**: C++ builds worker-bound
  `CallInvokerHolder`/`RuntimeExecutor` holders and calls a Kotlin bridge that builds
  a `TurboModuleManager` from your packages; the whole worker thread runs under the
  app classloader so JNI can resolve your classes. The manager is invalidated before
  the runtime is destroyed, so nothing leaks.

## Expo Modules in a worker

`requireNativeModule(...)` works inside a worker on both platforms, but the two
get there by opposite routes — because Expo's own install path differs:

- **iOS** — Expo's `AppContext` is bound to the app's main runtime, and the
  Swift↔C++ boundary makes binding a second one to a worker impractical. So the
  library installs its **own** `global.expo.modules` host object in the worker and
  forwards each call natively through Expo's public `AppContext` API. Native values
  go in and come back out; nothing crosses between runtimes. Events and live
  properties are read on the main thread and delivered back on the worker thread.
- **Android** — Expo's JNI install accepts a raw runtime pointer, so the library
  builds a genuine **per-worker `AppContext`** and lets Expo install `global.expo`
  against the worker runtime directly. Every feature runs through Expo's own code,
  with per-worker module instances (like the per-worker TurboModules above).

Because both lean on Expo internals, the compat matrix builds against each SDK to
catch the release that changes them.

## Thread hopping: one runtime, one lock

The experimental [`Thread`](./guides/threads) API runs a worker's *existing*
runtime on a different OS thread for the length of a callback — no second runtime,
no serialization.

What makes that safe is a **per-worker recursive lock** that every entry into the
runtime takes: the event loop, timers, native-module callbacks, the debugger, and
`Thread.run` alike. Exactly one thread is ever inside the runtime, so a `run()`
body is atomic against everything else. The lock machinery is always active — it
costs an uncontended mutex per JS task — and
`enableMultiThreadingExperimental()` only opens the door to it; it never switches
the protection on.

Promise settlement is posted back through the worker's own `CallInvoker`, which is
why `await` always resumes on the worker's own thread instead of silently leaving
your code on a foreign one, and why settlement goes inert on teardown.

## Lifetime & safety

Teardown is careful: on `terminate()` the worker finishes its current task, runs
pre-destroy cleanup (invalidating any TurboModule manager, removing this runtime's
store/value subscriptions) **while the runtime is still alive**, then the runtime is
destroyed on the worker thread. Cross-runtime callbacks route through the worker's
CallInvoker, which goes inert after teardown, so a late notification is dropped
safely rather than touching freed memory.

## Further reading

The repository's design docs go deeper on specific subsystems:

- the JSModule bridge design,
- the `defineModule` API design,
- the shared-data primitives spectrum.
