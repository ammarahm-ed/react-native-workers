# react-native-workers — Design Document

## 1. Goal

A React Native library that brings the browser **Web Worker** model to React Native
apps on **iOS and Android**:

1. **Web Workers spec compliance** (dedicated workers) — `new Worker(url)`,
   `postMessage` / `onmessage` / `onerror`, `terminate()`, `self` /
   `WorkerGlobalScope` semantics inside the worker, `close()`.
   **Explicitly out of scope per requirements: full structured clone and
   `SharedArrayBuffer` passing** — v1 messaging supports the JSON-serializable
   subset plus ArrayBuffers/TypedArrays (copied); full clone/transfer/SAB is
   designed here (§6.2) but deferred to a post-v1 phase.
2. **Native module access inside workers** — the worker runtime is a *headless
   React Native*: no UI, but TurboModules (and legacy NativeModules where feasible)
   load and work normally via `TurboModuleRegistry`.
3. **Automatic worker bundling** — the build scans source for `new Worker(...)`
   calls with relative paths and compiles each referenced file into its own JS
   bundle, placed alongside the main app bundle (dev server *and* release builds).
4. **JSI + C++ core** — shared C++ implementation, fast, non-blocking, targeting
   the New Architecture (bridgeless, RN 0.85+, Hermes).

## 2. Non-goals (initial releases)

- **Full structured clone & `SharedArrayBuffer`/Transferable passing** (per
  requirements; §6.2 documents the future path — v1 uses JSON-subset +
  copied ArrayBuffers).
- `SharedWorker` / `ServiceWorker` (no multi-document model in RN).
- Rendering / UIManager access from workers (headless only).
- Nested workers (`new Worker` inside a worker) — deferred to a later phase.
- Web APIs that don't exist in RN core (`fetch`/`XMLHttpRequest` etc. — provided
  only to the extent RN's own polyfill set can be initialized headlessly).

## 3. Project base (what we start from)

The repo is a fresh `create-react-native-library` (Bob 0.63) **pure C++ TurboModule**
scaffold — the ideal starting point:

- `cpp/ReactNativeWorkersImpl.{h,cpp}` — a `NativeReactNativeWorkersCxxSpec`-based
  C++ TurboModule (currently just `multiply`). Constructor already receives the
  host `CallInvoker`.
- **iOS**: `ios/OnLoad.mm` registers the module via
  `registerCxxModuleToGlobalModuleMap` (`ReactCommon/CxxTurboModuleUtils.h`);
  `ReactNativeWorkers.podspec` uses `install_modules_dependencies`.
- **Android**: no hand-written Java/Kotlin — `android/CMakeLists.txt` builds the C++
  module and links `jsi` + `reactnative` + codegen lib; `react-native.config.js`
  wires the cxx-module autolinking.
- Codegen: `codegenConfig` (`ReactNativeWorkersSpec`, `type: modules`,
  `includesGeneratedCode: true`).
- Example app: RN 0.85, React 19.2, **newArchEnabled=true, hermesEnabled=true**.

Implication: the worker core (runtime lifecycle, event loop, messaging, JSI
bindings) lives in shared C++ under `cpp/`, with only thin per-platform glue for
TurboModule host integration and bundle packaging.

## 4. Public API sketch

```ts
// Main thread (spec-shaped)
const worker = new Worker('./heavy-task'); // relative path, auto-bundled
worker.postMessage({cmd: 'start', data}); // JSON-subset + ArrayBuffers (copied) in v1
worker.onmessage = (e) => { ... };
worker.onerror = (e) => { ... };
worker.terminate();

// Inside ./heavy-task.ts (worker global scope)
import {TurboModuleRegistry} from 'react-native'; // native modules work
self.onmessage = (e) => { self.postMessage(process(e.data)); };
self.close();
```

## 5. Architecture — worker runtime

### 5.1 Key facts (verified in `node_modules/react-native`, RN 0.85.0)

| Fact | Where |
|---|---|
| A second Hermes VM is a supported, isolated construction: `HermesInstance::createJSRuntime(crashManager, msgQueueThread, ...)` calls `makeHermesRuntime` fresh each time — no singletons | `ReactCommon/react/runtime/hermes/HermesInstance.cpp:159` |
| The runtime abstraction (`JSRuntime`, `JSRuntimeFactory`, `JSIRuntimeHolder`) is engine-agnostic and instantiable N times | `ReactCommon/jsitooling/react/runtime/JSRuntimeFactory.h` |
| `TurboModuleBinding::install(jsi::Runtime&, moduleProvider, legacyProvider, longLivedObjectCollection)` takes **any** runtime + a provider lambda — no hidden coupling to "the" main runtime; call once per runtime | `ReactCommon/react/nativemodule/core/ReactCommon/TurboModuleBinding.cpp:117` |
| The full per-instance recipe exists in `JReactInstance`: JS `MessageQueueThread` → `ReactInstance` (creates its own `RuntimeScheduler`) → `RuntimeSchedulerCallInvoker` (jsCallInvoker) → `BridgelessNativeMethodCallInvoker` (native queue) → `TurboModuleManager(jsCallInvoker, nativeMethodCallInvoker, delegate)` → `installJSBindings` | `ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp:62-101` |
| iOS equivalent: `RCTTurboModuleManager initWithDelegate:jsInvoker:` + `installJSBindings:` → `TurboModuleBinding::install` | `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:910` |
| Each `ReactInstance` owns its own `RuntimeScheduler` with an HTML-spec microtask checkpoint (`drainMicrotasks` loop) — a per-worker event loop is built in | `ReactInstance.cpp:35`, `RuntimeScheduler_Modern.cpp:397` |
| Promise/callback retention is already runtime-scoped via `LongLivedObjectCollection::get(runtime)` | `TurboModuleBinding.cpp:164`, `react/bridging/LongLivedObject.h` |
| Bundle loading: `ReactInstance::loadScript` (evaluate a `JSBigString`), plus `registerSegment` for loading additional bundles into the same runtime | `ReactInstance.cpp:230,358` |
| Pure C++ TurboModules need **only a `CallInvoker`**: `registerCxxModuleToGlobalModuleMap`; `TurboModuleManager` consults this global map before Java/ObjC | `CxxTurboModuleUtils.h`, `TurboModuleManager.cpp:170` |
| No existing worker support anywhere in RN 0.85 (legacy WebWorkers long removed); Android HeadlessJS runs on the *main* runtime — not a model for isolation | verified by search |
| All required headers are exported to library consumers: Android prefab modules `reactnative`, `jsi`, `hermestooling` (+ `hermes-engine`); iOS pods ReactCommon / React-RuntimeCore / React-RuntimeHermes / React-NativeModulesApple / React-runtimescheduler / hermes-engine | `ReactAndroid/build.gradle.kts:649-660`, `ReactCommon/**/*.podspec` |
| Hermes runtime defaults to a 3 GB max-heap config named "RNBridgeless" — override per worker | `HermesInstance.cpp:137` |

### 5.2 Options considered

**Option A — Reuse RN's `ReactInstance` per worker (recommended).**
Each worker = its own JS thread (`MessageQueueThread`) + `HermesInstance::createJSRuntime`
+ a real `ReactInstance` wrapping it. We get for free: the `RuntimeScheduler`
event loop with correct microtask checkpoints, timers (`TimerManager`), buffered
runtime executors, error-handling plumbing (`JsErrorHandler`), `loadScript` /
`registerSegment`, and a `RuntimeSchedulerCallInvoker` to hand to TurboModules.
We then run the platform TurboModuleManager recipe (JReactInstance / RCTTurboModuleManager
pattern) against the worker runtime, and install our `WorkerGlobalScope` JSI
bindings on top.
- *Pros*: maximum reuse of supported, battle-tested RN machinery; TurboModules
  behave identically to the main runtime; smallest amount of bespoke event-loop
  code (event loops are where worker bugs live).
- *Cons*: `ReactInstance` isn't a public-public API (header-stable but internal);
  per-worker footprint is a full instance (~ a few MB + thread). Acceptable —
  web workers are heavyweight on browsers too.

**Option B — Raw Hermes runtime + hand-rolled event loop.**
`makeHermesRuntime` directly, our own run loop, our own timer wheel, manual
`drainMicrotasks`, manual `TurboModuleBinding::install` with hand-built invokers.
- *Pros*: total control, minimal deps, smallest footprint.
- *Cons*: re-implements `RuntimeScheduler`/`TimerManager` semantics (subtle:
  microtask checkpoints, task priorities, reentrancy); diverges from RN's
  behavior as RN evolves; no free error-handling integration. Kept as a fallback
  if `ReactInstance` reuse hits a wall (e.g. header/ABI gaps on one platform).

**Option C — Platform-level headless React hosts (HeadlessJsTaskService-style).**
Rejected: Android HeadlessJS shares the *main* runtime (no isolation, blocks the
app's JS thread); spinning full `ReactHost`s per worker drags in UI plumbing and
platform lifecycle we don't want.

**Decision: Option A**, with the C++ core structured so the runtime-owner is an
interface (`WorkerRuntimeHost`) — letting us swap in Option B later without
touching the messaging/bindings layers.

### 5.3 Worker composition (Option A)

```
┌────────────── Main runtime (app) ──────────────┐
│ JS: new Worker(ref) / postMessage / onmessage  │
│ JSI: WorkersHostBinding (CxxTurboModule)       │
└──────────────┬─────────────────────────────────┘
               │ C++ WorkerRegistry (owns all workers)
               ▼
┌────────────── Worker (one per instance) ───────┐
│ WorkerThread: MessageQueueThread (std::thread) │
│ HermesInstance::createJSRuntime (own VM/heap)  │
│ ReactInstance → RuntimeScheduler (event loop,  │
│   microtasks, TimerManager: setTimeout etc.)   │
│ RuntimeSchedulerCallInvoker (jsCallInvoker)    │
│ TurboModuleManager (platform glue, per worker) │
│   ├─ CxxTurboModules: work as-is               │
│   └─ Java/ObjC modules: via nativeMethodCall-  │
│      Invoker on worker's native queue          │
│ WorkerGlobalScope JSI bindings:                │
│   self, postMessage, onmessage, close, name,   │
│   location, console, structuredClone           │
│ Bundle: loadScript(worker bundle)              │
└────────────────────────────────────────────────┘
```

Per-platform glue (thin):
- **Android**: a small Kotlin `WorkerTurboModuleManagerDelegate` reusing the
  autolinking-generated module lists; C++ accesses it via JNI (mirror
  `JReactInstance.cpp`). Our library's CMake links prefab `reactnative`, `jsi`,
  `hermestooling`, `hermes-engine`.
- **iOS**: instantiate an `RCTTurboModuleManager` with the worker's `jsInvoker`
  and the host app's module provider/delegate; `installJSBindings` on the worker
  runtime.

**Native-module caveat (documented, enforced):** pure CxxTurboModules and
compute-style platform modules work naturally. UI-affine modules (UIManager,
anything assuming the main JS runtime) are blocked by a **denylist in the worker's
module provider**, returning `null` → `TurboModuleRegistry.get` returns null, and
`getEnforcing` throws a clear "not available in workers" error. Validating the
real-world module surface is an explicit early milestone (Phase 3).

## 6. Architecture — messaging & data passing

**Golden rule:** `jsi::Value`s / HostObjects must never cross runtimes (different
VMs — instant UB). All traffic goes through a C++-owned, runtime-neutral
intermediate representation.

### 6.1 Message serialization (v1)

A C++ `SerializedValue` tree (tagged union): primitives, strings, Arrays, plain
objects (with cycle/duplicate tracking via object IDs), Date, and
ArrayBuffer/TypedArray/DataView payloads **by copy**. Two passes:
`serialize(jsi::Runtime& src, jsi::Value) → SerializedValue` and
`deserialize(jsi::Runtime& dst, SerializedValue) → jsi::Value`. Throws
`DataCloneError`-shaped errors on functions, symbols, host objects. This is a
deliberate subset of structured clone (full clone — Map/Set/RegExp/Error,
transfer lists — is post-v1, §6.2); the C++ representation is designed so the
full clone is an additive extension, not a rewrite.

### 6.2 Transfer & sharing (post-v1, designed now)

- **Transferable `ArrayBuffer`**: JSI exposes `ArrayBuffer(runtime, MutableBuffer)`
  — an ArrayBuffer backed by a native `jsi::MutableBuffer`. Transfer = copy out /
  move the backing bytes into a C++ buffer, create a `MutableBuffer`-backed
  ArrayBuffer in the destination, and **detach** the source. Hermes' JSI does not
  yet expose a public `detach`; fallback strategy per engine capability:
  neuter via `HermesRuntime` internal API if available, else copy + best-effort
  poison (documented limitation until upstream detach lands).
- **`SharedArrayBuffer`**: not a native Hermes type today. We provide a
  spec-shaped `SharedArrayBuffer` polyfill class whose instances are
  `MutableBuffer`-backed ArrayBuffers sharing one refcounted C++ byte store —
  passing it in `postMessage` maps both runtimes onto the same memory.
  `Atomics.wait/notify` (if absent in Hermes) are backed by our C++ futex/condvar
  on the shared store. Exact Hermes SAB/Atomics support is verified in Phase 4's
  opening spike, and the polyfill shrinks to whatever the engine already provides.

### 6.3 Delivery & event loop integration

- Per-direction MPSC message queues owned by the C++ `WorkerChannel`.
- Main→worker delivery: enqueue, then schedule a drain task on the worker's
  `RuntimeScheduler` (its `CallInvoker`).
- Worker→main delivery: enqueue, then `invokeAsync` on the host runtime's
  `CallInvoker` (the one our TurboModule already receives).
- Messages posted before the worker finishes evaluating its bundle are queued and
  flushed after evaluation + `onmessage` assignment, matching browser semantics.
- `terminate()`: hard-stop — drop queued tasks, request Hermes async interrupt
  (`asyncTriggerTimeout`-style watchdog if a task is mid-flight), tear down the
  instance off-thread; `close()` inside the worker = graceful loop exit after the
  current task.
- Errors: uncaught worker exceptions → serialized `ErrorEvent` to the parent
  `onerror`; clone failures → `messageerror` on the receiving side, per spec.

## 7. Bundling — automatic worker compilation

Analysis of Metro 0.84.4 (as shipped with RN 0.85) shows all needed seams exist.

### 7.1 Key facts (verified in `node_modules/metro`)

| Fact | Where |
|---|---|
| The dev server serves **any file** as a standalone bundle: the request pathname becomes the entry file (`GET /src/my-worker.bundle?platform=ios&dev=true`) | `metro/src/Server.js:516`, `metro/src/lib/parseBundleOptionsFromBundleRequestUrl.js` |
| Metro already has per-`import()` **split-bundle machinery**: async deps get a `bundlePath` (`paths[moduleId]` → `.bundle?...&modulesOnly=true&runModule=false`) and are loaded at runtime via `global.__loadBundleAsync` | `metro/src/ModuleGraph/worker/collectDependencies.js`, `DeltaBundler/Serializers/helpers/js.js`, `metro-runtime/src/modules/asyncRequire.js`, `react-native/Libraries/Core/Devtools/loadBundleFromServer.js` |
| …but that machinery is **dev-only** (`includeAsyncPaths` is gated on `lazy=true`); production `react-native bundle` inlines everything into one bundle | `metro/src/Server.js:177,310,920` |
| Release builds are single-entry per invocation, but `unstable_buildBundleWithConfig` (community-cli-plugin) / metro `runBuild` are importable and can be **looped over N worker entries** | `@react-native/community-cli-plugin/dist/commands/bundle/buildBundle.js`, `metro/src/index.flow.js:309` |
| Babel plugins in the app preset run **inside Metro's transform**, so a plugin can rewrite `new Worker('./x')` and collect entries | `metro-transform-worker/src/index.js:351` |
| `import.meta` is NOT supported by Metro/RN babel preset — the `new Worker(new URL('./w.js', import.meta.url))` form needs dedicated syntax handling | verified: zero references in metro + preset |
| iOS embeds bundles via `react-native-xcode.sh` (copies to app resources next to `main.jsbundle`, Hermes-compiles); Android via the RN Gradle plugin `bundle*JsAndAssets` into `assets/` | `react-native/scripts/react-native-xcode.sh:155-186` |
| Config hooks available: `serializer.customSerializer`, `server.rewriteRequestUrl`, `server.enhanceMiddleware`, `transformer.getTransformOptions` | `metro-config` `types.js.flow` |

### 7.2 Chosen design

**Babel plugin (`@ammarahmed/react-native-workers/plugin`)** — added to the app's
`babel.config.js` (Reanimated-style). It:

1. Detects `new Worker('<relative-or-package-path>')` and
   `new Worker(new URL('./w.js', import.meta.url))` (we handle the `import.meta`
   form entirely inside the plugin, before Metro ever sees it).
   **Every exported worker constructor must be tracked, not just `Worker`.**
   `UIWorker` is a subclass with the same signature, so it needs identical
   rewriting; the plugin keeps the set explicit:

   ```js
   const WORKER_EXPORTS = new Set(['Worker', 'UIWorker']);
   ```

   This was a real shipped defect — file-based `UIWorker`s were silently broken
   (the raw specifier survived and the runtime fetched a path that did not
   exist, giving a 404 at construction). It was invisible to the test suite
   because every file-based test used `Worker` and the one `UIWorker` test used
   an inline string. Any future exported constructor taking a worker source must
   be added here **and** covered by a file-based test.
2. Resolves the path against the current file, and rewrites the call to
   `new Worker(__workerRef('<project-relative-entry>'))` where `__workerRef`
   is our runtime helper that maps an entry id → a loadable bundle location.
3. Records the entry in a **worker manifest** (written under the app's
   `.react-native-workers/` cache dir) so the release build step knows what to
   compile. Dev mode needs no manifest — the dev server can serve any entry
   on demand.

**Dev mode:** the native side fetches
`http://<metro-host>/<entry>.bundle?platform=<p>&dev=true&runModule=true`
exactly like RN's own `loadBundleFromServer`, and evaluates it in the worker
runtime. HMR for workers is a later phase (initially: reload worker on file
change via the existing delta endpoint or full re-fetch).

**Release mode:** a small CLI (`npx react-native-workers bundle`) that wraps
`unstable_buildBundleWithConfig` in a loop over the manifest entries, emitting
`<entry-hash>.worker.jsbundle` files + a `workers-manifest.json`. Wired into
the app build via:
- **iOS**: an extra Xcode build-phase line (or podspec `script_phase`) that runs
  after `react-native-xcode.sh` and copies/Hermes-compiles worker bundles into
  `$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH`.
- **Android**: a Gradle task shipped in our library (`android/worker-bundles.gradle`
  applied via autolinking or one `apply from:` line) that runs alongside
  `bundle<Variant>JsAndAssets` and drops outputs into `src/main/assets/workers/`.

**Runtime resolution:** `__workerRef(id)` asks the native module whether we're in
dev (Metro URL) or release (asset path `workers/<hash>.jsbundle`), so `Worker`
construction is uniform in JS.

### 7.3 Alternatives considered

- **Reuse Metro's async-split (`asyncType`) machinery** by making the babel plugin
  emit an `import()`-shaped dependency: elegant in dev (Metro emits `paths`
  automatically), but it's `lazy`-gated (dev-only), couples us to Metro
  internals, and the worker bundle must be a *root* bundle (own prelude +
  `runModule`), not a `modulesOnly` fragment sharing the parent's module table —
  workers have an isolated runtime, so sharing module IDs with the host bundle is
  wrong anyway. **Rejected** in favor of plain multi-entry bundles.
- **`serializer.customSerializer` side-emission** of worker bundles during the
  main build: works but hijacks a hook apps may already use (Expo, Sentry), and
  runs at an awkward point for writing extra files. **Rejected** as primary path;
  may be offered later as a zero-CLI convenience.
- **Re.pack/webpack**: real code-splitting, but abandons Metro. Out of scope.

## 8. Repository layout (target)

```
cpp/
  core/            WorkerRegistry, Worker, WorkerChannel, SerializedValue (clone)
  runtime/         WorkerRuntimeHost (iface), ReactInstanceWorkerHost (Option A)
  bindings/        WorkerGlobalScope installers, host-side Worker binding
  ReactNativeWorkersImpl.*   host TurboModule (spec: createWorker, postMessage,
                             terminate, event sink; bundle-URL resolution)
ios/               RCTTurboModuleManager glue, bundle loading (NSBundle/Metro)
android/           Kotlin delegate glue + JNI, asset/Metro bundle loading, CMake
src/               JS: Worker class, events, plugin runtime helpers (__workerRef)
plugin/            babel plugin (scan + rewrite + manifest)
cli/               worker bundle builder (wraps unstable_buildBundleWithConfig)
scripts/           iOS build-phase script; android/worker-bundles.gradle
```

## 9. Phased implementation plan

Each phase ends runnable in the example app. **Detailed per-phase specs live in
[`phases/`](phases/README.md)** — this section is the summary.

**Phase 0 — Runtime spike (de-risk everything).**
In the existing C++ TurboModule: spin a `std::thread` + `MessageQueueThread`,
create a second Hermes runtime via `HermesInstance::createJSRuntime`, evaluate a
hardcoded script string, round-trip a string via crude callbacks. Do this on
**both platforms** immediately — it validates prefab/pod linkage (the riskiest
unknown) before any real design code. *Exit criteria*: example app logs a
worker-computed value on iOS + Android.

**Phase 1 — Worker core (single runtime, inline script).**
`WorkerRegistry`/`Worker`/`WorkerChannel`; wrap the runtime in `ReactInstance`
(scheduler, microtasks, TimerManager); `WorkerGlobalScope` bindings (`self`,
`postMessage`, `onmessage`/`addEventListener`, `close`, `name`, `console` piped
to host log); v1 serializer (§6.1: primitives, objects/arrays, cycles, typed
arrays — copy only); error propagation (`onerror`); `terminate()`. JS-side
`Worker` class with spec-shaped events. *Exit criteria*: spec-shaped ping-pong
with objects + timers inside worker; clean terminate with no leaks (ASAN run).

**Phase 2 — Bundling & loading (dev first, then release).**
Babel plugin scanning/rewriting `new Worker()` (both string and
`new URL(..., import.meta.url)` forms); dev: native fetch of
`<entry>.bundle?platform=...` from Metro (mirror `loadBundleFromServer`) +
`loadScript`; release: `cli/` multi-entry builder + Gradle task + Xcode phase
script, asset loading via `JSBigFileString`/NSBundle. Worker reload on
file change (full HMR deferred). *Exit criteria*: `new Worker('./fib')` works in
dev and in a release build on both platforms with zero manual config beyond
babel-plugin + build-script installation.

**Phase 3 — TurboModules inside workers.**
Per-worker `TurboModuleManager` on both platforms (JReactInstance /
RCTTurboModuleManager recipes); `TurboModuleBinding::install` into the worker;
minimal headless JS prelude so `react-native`'s `TurboModuleRegistry` import path
works in worker bundles (either RN's own `InitializeCore` subset or a slim
custom prelude — decided by experiment early in the phase); module denylist +
clear errors for UI-affine modules; an audit matrix of core modules
(blob, fs-style community modules, networking, crypto) tested from a worker.
*Exit criteria*: a worker calls a pure CxxTurboModule and at least two real
platform TurboModules correctly; denylisted module fails with a clear message.

**Phase 4 — Spec conformance & polish (v1 release).**
WPT-derived dedicated-worker test suite running in the example app (message
ordering, event timing, queue-before-onmessage, error events, close/terminate
races); `messageerror`; `MessageChannel`/`MessagePort` if not landed earlier;
docs (API, native-module compatibility table, limitations vs web); CI (build
both platforms, C++ unit tests for clone/queue via gtest host build); perf pass
(worker startup time, message throughput, per-worker memory with tuned Hermes
heap config).

**Phase 5 (post-v1) — Full structured clone, Transferables & shared memory.**
Opening spike: verify current Hermes ArrayBuffer detach + SAB/Atomics surface.
Then: full clone types (Map/Set/RegExp/Error), transfer lists in `postMessage`
(ArrayBuffer move + detach), `MutableBuffer`-backed shared store,
`SharedArrayBuffer` (native or polyfill), `Atomics.wait/notify` backing,
`structuredClone()` global (per §6.2). *Exit criteria*: zero-copy transfer
benchmark vs copy; SAB visible from both sides; Atomics handshake test passes.

**Later / stretch:** nested workers, worker HMR, `fetch` in workers,
Chrome DevTools inspector integration for worker runtimes
(`jsinspector-modern` page registration — the hooks exist in `JSRuntime`).

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `ReactInstance` is internal API; headers could shift across RN versions | Isolate behind `WorkerRuntimeHost`; CI against RN main; Option B fallback |
| Platform TurboModules with main-runtime/thread assumptions misbehave in workers | Per-worker `nativeMethodCallInvoker`; denylist + audit matrix (Phase 3); document |
| Hermes lacks public ArrayBuffer detach / native SAB | Phase 4 spike first; polyfill strategy in §6.2; track upstream Hermes |
| Release multi-bundle needs build-system hooks users must install | One-line Gradle `apply from:` + podspec `script_phase`; loud runtime error listing missing bundles |
| Metro internals (`unstable_buildBundleWithConfig`) churn | Pin per-RN-version ranges; fall back to shelling out to `react-native bundle` per entry |
| Per-worker memory footprint (default 3 GB heap cfg, full instance) | Tune `RuntimeConfig` per worker; document worker cost; lazy TM manager creation |

