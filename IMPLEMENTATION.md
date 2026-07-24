# Implementation Status

What is actually built and verified in this repo. The in-app suite
([`example/src/conformance.ts`](example/src/conformance.ts),
[`example/src/bridgeTests.ts`](example/src/bridgeTests.ts),
[`example/src/primitivesTests.ts`](example/src/primitivesTests.ts)) plus
benchmarks ([`example/src/bench.ts`](example/src/bench.ts)) are the source of
truth; the example app is a gallery of screens exercising the whole API surface.

**Verification state:** the current suite is **76/76 on iOS** (iPhone 17 Pro sim,
iOS 26.1). The core was previously verified 20/20 on both iOS and
**Android** (Pixel_5_API_36), but the changes in follow-ups 8–12 below and all
of the example screens are **iOS-verified only** — Android has not been re-run
since. Treat the Android column as stale until it is.

## Feature status

| Capability | Status | Notes |
|---|---|---|
| Second Hermes runtime per worker (own thread + event loop) | ✅ | Raw `makeHermesRuntime` + hand-rolled loop with microtask checkpoints & timers |
| `new Worker({inline})` messaging (`postMessage`/`onmessage`) | ✅ | |
| Structured clone (objects, arrays, cycles, dedup, Date, TypedArray, ArrayBuffer) | ✅ | v1 subset; Map/Set/RegExp/Error and BigInt not yet cloned |
| Pre-handler message buffering (spec port queue) | ✅ | host + inline |
| `self`, `close()`, `addEventListener`, `MessageEvent`/`ErrorEvent` | ✅ | |
| Timers (`setTimeout`/`setInterval`/`queueMicrotask`) + Promises | ✅ | |
| Error propagation → parent `onerror`; worker survives | ✅ | |
| `terminate()` + off-thread teardown; multi-worker isolation | ✅ | tight-loop interrupt is a known limitation (Hermes) |
| `structuredClone()` global | ✅ | host + worker |
| **C++ (Cxx) TurboModules inside workers** | ✅ | both platforms; per-runtime instance bound to worker CallInvoker |
| **Platform (ObjC/Java) TurboModules inside workers** | ✅ opt-in | Opt-in per worker via `{ nativeModules: true }` (default is a lightweight Cxx-only binding). iOS: per-worker `RCTTurboModuleManager` resolves ALL ObjC modules via the global registry, zero app cooperation ([ios/WorkerTurboModules.mm](ios/WorkerTurboModules.mm)). Android: per-worker `TurboModuleManager` built from the app's registered `ReactPackage`s ([cpp/bindings/WorkerTurboModulesAndroid.cpp](cpp/bindings/WorkerTurboModulesAndroid.cpp) + Kotlin [WorkerTurboModules](android/src/main/java/com/ammarahmed/reactnativeworkers/WorkerTurboModules.kt)); app calls `WorkerTurboModules.initialize(context, packages)` once. Manager is invalidated before the worker runtime is destroyed (no leak) |
| **Nested workers** (`new Worker` inside a worker) | ✅ | rides on per-runtime module instance |
| **`NativeEventEmitter` inside workers** (device events) | ✅ | worker gets `global.__rctDeviceEventEmitter` + `NativeEventEmitter`; Cxx-module emits land on the worker via its CallInvoker, and host-originated device events (incl. Java/ObjC modules) are forwarded to opted-in workers by wrapping the host `__rctDeviceEventEmitter.emit` |
| **Native worker API** (create/drive from C++, any thread) | ✅ | [`cpp/api/NativeWorkers.h`](cpp/api/NativeWorkers.h), JSON bridge |
| **Flat binary message codec** (one buffer + out-of-band blobs) | ✅ | [`cpp/core/MessageCodec.cpp`](cpp/core/MessageCodec.cpp) — replaced the per-node tree |
| **SharedStore** (cross-worker shared state; lazy reads + granular `getIn`/`setIn`/`merge`/`deleteIn`; watchers + `subscribeIn` deltas; `batch`) | ✅ | [`cpp/core/SharedStore.cpp`](cpp/core/SharedStore.cpp), immutable node tree w/ inline scalar leaves; verified cross-worker |
| **JSModule bridge** (typed two-way RPC host↔worker: async calls, events, `parent` callbacks) | ✅ | [`src/bridge.ts`](src/bridge.ts) + prelude mirror; JS layer over the message channel; design: [`docs/jsmodule-bridge.md`](design-docs/jsmodule-bridge.md) |
| **`defineModule`** (one typed contract → symmetric `worker()`/`host()` + reactive `state`) | ✅ | [`src/defineModule.ts`](src/defineModule.ts) + [`src/reactive.ts`](src/reactive.ts) + prelude mirror; [`docs/jsmodule-defineModule.md`](design-docs/jsmodule-defineModule.md) |
| **`SharedValue`** (single synchronous cell; lock-free atomic for numbers) | ✅ | [`cpp/core/SharedValue.cpp`](cpp/core/SharedValue.cpp); ~0.11 µs/op, ~3× faster than SharedStore per value |
| **`SharedBuffer`** (raw shared memory across runtimes + named lock) | ✅ | [`cpp/core/SharedBuffer.cpp`](cpp/core/SharedBuffer.cpp); shared `MutableBuffer`→ArrayBuffer views; ~6–10× faster than SharedStore for bulk; [`docs/shared-data-primitives.md`](design-docs/shared-data-primitives.md) |
| **Refcounted lifetime for all three shared primitives** (+ `static delete(name)`) | ✅ | weak registries; data freed when the last handle in any runtime drops. See follow-up 8 |
| **Bridge teardown semantics** (`WorkerTerminatedError`) | ✅ | in-flight calls + `ready()` waiters reject with `code: 'ERR_WORKER_TERMINATED'`; fire-and-forget calls do not raise unhandled rejections. See follow-up 9 |
| **UIWorker** (worker JS runs on the UI/main thread) | ✅ both | [`cpp/runtime/UiWorkerHost.cpp`](cpp/runtime/UiWorkerHost.cpp); iOS via `dispatch_get_main_queue` ([`ios/MainThreadScheduler.mm`](ios/MainThreadScheduler.mm)), Android via a main-`Looper` `Handler` ([`cpp/runtime/MainThreadSchedulerAndroid.cpp`](cpp/runtime/MainThreadSchedulerAndroid.cpp) + Kotlin `MainThreadScheduler`) |
| Auto-bundling: babel scans/rewrites `new Worker('./x')` / `new UIWorker('./x')` | ✅ | [`plugin/index.js`](plugin/index.js) + manifest journal; both exported constructors are tracked (`WORKER_EXPORTS`) |
| Dev loading of `new Worker('./x')` from Metro | ✅ | JS fetches the Metro bundle → inline; verified E2E both platforms |
| Release bundling CLI + Gradle/Xcode wiring | ✅ (tooling) | [`cli/index.js`](cli/index.js); native asset reader is the remaining companion piece |
| Benchmarks (round-trip latency, large payload throughput) | ✅ | in-app |
| Transfer-list zero-copy detach / `SharedArrayBuffer` | ⛔ out of scope | excluded by requirement 1; Hermes lacks ArrayBuffer detach & native SAB |

## Measured performance (Pixel_5_API_36 emulator, debug)

Messaging:
- Message round-trip: **~0.15 ms/msg** (500× ping-pong).
- 8 MB `Uint8Array` transfer: ~5.5 ms (~1500 MB/s) — zero-copy binary on decode.
- 50k-element array clone: ~27 ms.
- Native (C++-created) worker round-trip: ~3.6 ms.

SharedStore (after the low-overhead rewrite — see below):
- Host `set`+`get` round-trip: **~5.8 µs/op** Android, **~3.8 µs/op** iOS
  (was ~7.5 / ~5.0).
- 50k-array `set`+`get`: ~11.5 ms Android, ~7.5 ms iOS (was ~15 / ~8.7).
- Worker `set` → host watcher: ~0.008 ms/event end-to-end (500/500 delivered).
- Contended writes (4 workers × 1000): ~510k ops/s Android, ~915k iOS (was
  ~360k / ~690k), no loss/corruption.

SharedStore vs messaging (same payload, host→worker):
- Small `{n}` ×1000: **parity** — both ~0.002–0.003 ms/op (iOS), ~0.005 ms/op
  (Android).
- 10k-array ×100: **parity / SharedStore ahead** — Android SharedStore ~1.8 ms/op
  vs messaging ~2.2 (SharedStore ~1.2× faster); iOS ~1.7 vs ~1.1 (messaging ~1.5×).
  Roughly even, because inline scalar leaves decode without the flat codec.

Granular update — publish 200 incremental changes to a 200-field state object:
- messaging (re-send whole): ~0.6 / ~0.47 ms/op (Android / iOS)
- `set` (re-publish whole): ~0.59 / ~0.53 ms/op
- **`setIn` (one field): ~0.14 / ~0.11 ms/op — ~4× faster than messaging**, ~8×
  faster than a naive whole-object round-trip. This is the payoff of the node
  tree: a small change encodes one value and rebuilds only the root→path spine.

Node-tree model + lazy/granular API ([`cpp/core/SharedStore.cpp`](cpp/core/SharedStore.cpp)):
- A stored value is an **immutable, structurally-shared tree of nodes**, not one
  flat blob: `Leaf` (a primitive stored *inline* — number/bool/string/null — or,
  for typed arrays / Date / ArrayBuffer / class instances, an encoded `Message`),
  `Object` (map of child nodes), `Array` (vector of child nodes). Plain objects
  and arrays explode into nodes; a JS classifier decides plain-object vs leaf.
- **Lazy reads:** `get(key)` returns a snapshot proxy (`HostObject` for objects,
  a real array with lazy elements for arrays); only the leaves you touch decode.
  `getIn(key, path)` decodes just one subtree. Snapshot semantics — the proxy
  reflects the store as of the `get` call (nodes are immutable).
- **Granular writes:** `setIn(key, path, value)` encodes only `value` and
  copy-on-write rebuilds just the root→path spine (O(depth), untouched siblings
  pointer-shared) — no whole-value re-encode. Works for object keys and array
  indices. `merge(key, partial)` deep-merges objects (COW); `deleteIn(key, path)`
  removes a node (array entries splice).
- **Granular notify:** `subscribeIn(key, path, cb)` fires only when a change
  touches that subtree and delivers `(relPath, changedSlice)` — not the whole
  value. Legacy `subscribe`/`watch` still fire with `(key, wholeValue)`.
- **Inline scalar leaves** are what keep the tree fast: a 50k-number array
  explodes into inline-number nodes (no `encode`/`Message` per element), so whole
  `set`/`get` of scalar-heavy data is as fast as — or faster than — the old flat
  blob, while still being granularly addressable.
- Per-runtime subscriptions are tracked and removed on teardown (limitation #6);
  values move by `shared_ptr` (no buffer copies in get/set/notify); the store
  mutex is held only for the map op; `notify` is skipped when a key has no
  watchers; the store methods are bound **once** into a plain JS object (not a
  re-dispatching `HostObject`).
- **Tradeoff:** a value with a cycle *spanning* object boundaries can't be split
  (the flat codec dedups/handles cycles only within one `Message`); such a subtree
  falls back to a single leaf blob. Very wide plain objects cost one node per key.

(Release builds and real devices will be faster; these are debug-emulator
numbers for regression tracking. See [`example/src/bench.ts`](example/src/bench.ts).)

## Architecture (as built)

```
JS (host)                         C++ core (cpp/)                    Worker runtime
─────────                         ──────────────                     ──────────────
Worker (src/Worker.native.ts) ─► ReactNativeWorkersImpl (TurboModule)
  postMessage / onmessage           │  install / createWorker / terminate
  (message buffering)               │  HostDelivery (→ host CallInvoker)
                                    ▼
                              WorkerRegistry (in module)
                                    │ owns
                                    ▼
                                  Worker  ──►  HermesWorkerHost (own thread)
                                    │            makeHermesRuntime + event loop
                                    │            (tasks, timers, drainMicrotasks)
                                    │            InertInvoker (CallInvoker)
                                    ├─ WorkerGlobalScope bindings + prelude
                                    ├─ TurboModuleBinding::install (Cxx provider)
                                    └─ SerializedValue (structured clone)

Native/UI-thread path:  NativeWorkers (cpp/api) ─► Worker (JSON message bridge)
Bundling:  plugin/ (babel scan+rewrite) + cli/ (release) + scripts/, android/*.gradle
```

Key source files: [`cpp/core/`](cpp/core/) (Worker, SerializedValue, types),
[`cpp/runtime/HermesWorkerHost.cpp`](cpp/runtime/HermesWorkerHost.cpp),
[`cpp/bindings/`](cpp/bindings/) (global scope, prelude, TurboModules),
[`cpp/api/NativeWorkers.cpp`](cpp/api/NativeWorkers.cpp),
[`cpp/ReactNativeWorkersImpl.cpp`](cpp/ReactNativeWorkersImpl.cpp).

## Known limitations / follow-ups

1. **Release asset loading** — dev bundled workers work (JS `fetch` of the Metro
   bundle, verified: `new Worker('./workers/double')` → 42 on both platforms).
   The release CLI produces per-worker bundles, but the native side still needs a
   native asset reader (iOS `NSBundle` / Android `AssetManager`) to load release
   `.jsbundle` files. Nested *bundled* workers in dev also need this (workers have
   no `fetch`); nested *inline* workers already work.
2. **Platform (Java/ObjC) TurboModules in workers — DONE on both platforms.**
   iOS: a per-worker `RCTTurboModuleManager` with a generic delegate resolves
   every registered ObjC module via the process-global `RCTGetModuleClasses()`
   registry — no app cooperation. Android: since there is no such global registry,
   the library now ships a Kotlin bridge + JNI. For each worker,
   [`WorkerTurboModulesAndroid.cpp`](cpp/bindings/WorkerTurboModulesAndroid.cpp)
   builds worker-bound `CallInvokerHolder` / `NativeMethodCallInvokerHolder` /
   `RuntimeExecutor` holders (via fbjni `newObjectCxxArgs`) and calls the Kotlin
   [`WorkerTurboModules.installOnWorker`](android/src/main/java/com/ammarahmed/reactnativeworkers/WorkerTurboModules.kt),
   which constructs a `TurboModuleManager` whose `init{}` installs
   `__turboModuleProxy` onto the worker runtime. The app registers its packages
   once: `WorkerTurboModules.initialize(reactApplicationContext, packages)` (e.g.
   from a `ReactInstanceEventListener`). Notes:
   - **Opt-in per worker.** Building the platform manager costs memory and needs
     teardown, so it is only built when the worker is created with
     `{ nativeModules: true }`. Default workers get a lightweight Cxx-only binding
     (`globalExportedCxxTurboModuleMap`) — enough for nested workers + C++ modules
     — with nothing to tear down. The flag threads through
     `createWorker(...)`/`createUIWorker(...)` (codegen spec) → `Worker` →
     `installWorkerTurboModules(rt, invoker, nativeModules)`.
   - **Teardown happens before terminate.** The platform manager is invalidated on
     the worker thread WHILE the runtime is still alive, via a `preDestroy` hook
     the host runs just before destroying the runtime
     ([`WorkerRuntimeHost::setPreDestroy`](cpp/runtime/WorkerRuntimeHost.h)):
     Android calls `TurboModuleManager.invalidate()` (JNI) then releases the
     manager global-ref; iOS calls `[RCTTurboModuleManager invalidate]` (its
     `_moduleHolders.clear()` runs synchronously on the calling thread). This
     tears down the worker's module instances — including the Cxx module's
     `jsi::WeakObject`s — against a live runtime, avoiding the earlier
     use-after-free crash. No per-worker leak.
   - The worker delegate is a `DefaultTurboModuleManagerDelegate` built from the
     app-provided `ReactPackage` list (autolinked third-party modules) **plus RN's
     built-in `CoreReactPackage`**, which the library prepends automatically —
     mirroring what `ReactInstance` does for the host — so core modules
     (`SourceCode`, `PlatformConstants`, `DeviceInfo`, …) resolve in workers with
     no extra app setup. `CoreReactPackage` is Kotlin-`internal`, so it's built
     reflectively (best-effort; workers just miss core modules if RN internals
     change, never a crash).
   - The whole worker thread body runs under `fbjni::ThreadScope::WithClassLoader`
     ([`WorkerThreadScope`](cpp/runtime/WorkerThreadScope.h)) so JNI `FindClass`
     resolves app classes for the worker's entire lifetime (the worker runs on a
     raw `std::thread` with no app classloader on its stack otherwise).
   - Native module methods run inline on the worker JS thread (a dedicated native
     queue is a follow-up).
   - If the app never calls `initialize`, `nativeModules: true` workers fall back
     to Cxx-only modules.
   - **`NativeEventEmitter` now works in workers** (both platforms). The worker
     prelude installs `global.__rctDeviceEventEmitter` + a `NativeEventEmitter`
     class. Two delivery paths, matching how RN itself routes events:
     - **Cxx TurboModules** emit via `TurboModule::emitDeviceEvent`, which uses
       the module's `jsInvoker_` (the worker's) and reads that runtime's
       `__rctDeviceEventEmitter` — so their events land directly on the worker.
     - **Java/ObjC modules** emit on the host runtime (`callFunctionOnModule`),
       which ignores the CallInvoker. The host module wraps the shared host
       `__rctDeviceEventEmitter.emit` ([`installDeviceEventBridge`](cpp/ReactNativeWorkersImpl.cpp))
       and forwards each event to workers that registered a listener (a worker
       signals interest via `__workerEnableDeviceEvents`; only opted-in workers
       are forwarded, and forwarding is skipped entirely when none exist).
       Event args are structured-cloned; non-cloneable payloads are delivered to
       the host only.
     Follow-up: per-module `addListener`/`removeListeners` counts are forwarded to
     the module instance the worker resolved, but reference-counting to *stop*
     host-side observation when the last worker unsubscribes isn't wired yet.
2b. **`UIWorker` on Android — DONE.** Both platforms now register a
   `MainThreadScheduler`: iOS posts to `dispatch_get_main_queue`
   ([`ios/MainThreadScheduler.mm`](ios/MainThreadScheduler.mm)), Android posts a
   `Runnable` onto a `Handler` bound to the main `Looper`
   ([`cpp/runtime/MainThreadSchedulerAndroid.cpp`](cpp/runtime/MainThreadSchedulerAndroid.cpp)
   + Kotlin `MainThreadScheduler`). The scheduler is constructed lazily on the
   first `getMainThreadScheduler()` caller.
3. **Terminating a tight `while(true)` worker** — needs a Hermes async interrupt;
   currently `terminate()` takes effect after the current task/microtasks.
4. **Full structured clone** (Map/Set/RegExp/Error/BigInt), **transfer-list
   detach**, **SharedArrayBuffer** — designed in phase-5; excluded from v1 scope.
5. **Sanitizer/CI passes and WPT-derived suite** — the in-app suite covers
   behavior; ASAN/TSAN and a formal WPT harness remain (phase-4 doc).
6. **SharedStore subscription lifetime across `terminate()` — DONE.** A
   subscription created inside a worker lives in the process-global store. Two
   defenses, both in place: (a) the delivery poster routes through the worker's
   `CallInvoker` ([`cpp/core/Worker.cpp`](cpp/core/Worker.cpp)), which goes inert
   when the host is destroyed, so a `set`/`delete` racing teardown is **safely
   dropped** rather than crashing (this fixed a use-after-free SIGSEGV in
   `StoreData::notify`, caught by the `deliver … vs SharedStore` benchmark); and
   (b) each runtime's subscriptions are tracked in a `RuntimeSubscriptions` set and
   **removed from their stores on teardown** (`installSharedStore` returns a cleanup
   run in `setPreDestroy`, on the worker thread with the runtime alive, alongside
   the TurboModule-manager invalidate). So a terminated worker leaves no stale
   subscriber and no leaked `jsi::Function`, and `notify` no longer iterates dead
   watchers.
7. **JSModule bridge** ([`src/bridge.ts`](src/bridge.ts) + a hand-written mirror in
   the worker prelude). A typed, two-way RPC layer built entirely in JS over the
   existing message channel — no new native threads. Bridge envelopes are tagged
   (`__rnwb`) and multiplexed alongside user `postMessage`; each side intercepts
   them (host: `Worker.__deliver`; worker: wraps `__rnworkersDispatchMessage`)
   before `onmessage`. Modules register on either side; the other side gets a
   typed `Proxy` whose methods return `Promise`s (correlation-id call/result), plus
   fire-and-forget events. **Sync note:** blocking sync *invocation* is
   intentionally not offered (single-threaded Hermes → deadlock/UI-jank risk);
   synchronous *data* is served by `SharedStore` (get/getIn/setIn), which is the
   recommended fast-param path. A native blocking-sync primitive (semaphore +
   re-entrant pump) is a documented follow-up. See
   [`docs/jsmodule-bridge.md`](design-docs/jsmodule-bridge.md).
8. **Shared-primitive lifetime — DONE (was: permanent leak).** All three
   registries previously held owning references, so every name ever opened lived
   until the process died — bad for dynamically named data (per session, per
   document). Registries now hold **`std::weak_ptr`**, so the data is freed when
   the last handle in any runtime drops; `sweepExpiredLocked` prunes dead entries
   past a small threshold. Each primitive also exposes a `static delete(name)`
   escape hatch for deterministic release, which *detaches* the name rather than
   invalidating live handles (prior handles keep working against an orphan; the
   next open allocates fresh). For `SharedBuffer` the cross-runtime mutex was
   moved **into `SharedMem`** so it shares the memory's identity and lifetime
   exactly, with `openLock` handing out a `shared_ptr` via the aliasing
   constructor instead of maintaining a second registry that could outlive or
   diverge from the buffer.
   A `__rnworkersCollectGarbage()` hook (`jsi::instrumentation`) exists to make
   the refcount behaviour testable from the in-app suite.
9. **Bridge teardown — DONE.** `dispose()` still rejects every in-flight call
   (they can never complete), but now with a typed `WorkerTerminatedError`
   (`code: 'ERR_WORKER_TERMINATED'`) that names the call. Each pending entry
   keeps a reference to the promise it handed out, so `dispose` attaches its own
   handler *before* rejecting — marking it handled without consuming it, so
   awaiting callers still see the error while fire-and-forget calls no longer
   surface as `Uncaught (in promise)`. Unmounting a screen mid-call is ordinary,
   not an error. Pending `ready()` waiters are cancelled the same way instead of
   firing a misleading timeout long after the worker is gone.
   **Known gap:** `terminate()` does not drain, so a fire-and-forget call issued
   immediately before it may never execute. An `await w.terminate({ drain: true })`
   is the obvious follow-up.
10. **Device-event emitter hardening — DONE.** `blob-util` crashed on iOS only,
   with "attempted to use private field on non-instance". Root cause was ours:
   [`ios/WorkerTurboModules.mm`](ios/WorkerTurboModules.mm) invoked the forwarded
   `emit` with an undefined receiver. RN's `RCTDeviceEventEmitterImpl` keeps its
   listener registry in a Babel loose-mode private field, so `emit` must be a
   **method** call — fixed with `callWithThis` (which is what RN's own
   `emitDeviceEvent` uses, for the same reason). As general defence the prelude
   also installs a self-bound own `emit` shadowing the prototype
   (`__rnworkersHardenDeviceEmitter`), so any other caller that loses the receiver
   still works. Android was unaffected — it has no equivalent ObjC-emitter shim.
11. **Worker timer teardown — DONE.** `timers_` / `tasks_` are cleared on the
   worker thread before the runtime is destroyed, so pending callbacks holding
   `jsi` values are released against a live runtime.
12. **Example-only native code lives outside the library.** `example-modules/` at
   the repo root holds private packages the example links locally (currently
   `uiworker-demo`). How a `UIWorker` is *used* is application code, not library
   scope; keeping it out means demos can use C++/ObjC/UIKit freely without any of
   it becoming supported API. The demo is a **Cxx** TurboModule specifically
   because ObjC TurboModules post void methods to a method queue
   (`performVoidMethodInvocation`, `RCTTurboModule.mm`) and so are never direct
   calls; Cxx modules have no method queue and run synchronously on the calling
   thread. iOS-only for now (`android: null`).

## How to run

Build/run: `cd example && ../node_modules/.bin/react-native run-ios --simulator "iPhone 16"`
or `run-android`. The example app runs the conformance suite + benchmarks on
launch. See [`memory`] build-run-workflow for the Yarn/codegen specifics.
