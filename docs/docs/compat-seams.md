---
sidebar_position: 12
title: Hacks & Compatibility Seams
slug: /compat-seams
---

# Hacks & compatibility seams

This library runs a second JavaScript runtime inside an app whose native layer was
written on the assumption that there is exactly one. Most of what follows exists
because of that single mismatch.

None of it is hidden in the source, so it should not be hidden here either. Each
entry says **what** we do, **why** it is necessary, **what it costs you**, and
**what upstream change would let us delete it**. If you maintain React Native,
Hermes, or Expo, the last line of each section is the ask.

Nothing here is a complaint. These are all reasonable designs for the
single-runtime case that we happen to be standing outside of.

---

## Simulated `ArrayBuffer` transfer

**What we do.** `postMessage(value, [buffer])` moves the buffer's backing store
instead of copying it. Afterwards the library records the buffer as transferred in
a side table, refuses to clone or re-transfer it, and reports `buffer.detached ===
true` through a getter composed with the engine's own. The optional
[`enableTransferGuard()`](/docs/guides/messaging#after-you-transfer) patches
`Uint8Array`, `DataView` and `%TypedArray%.prototype` so *new* reads and writes
throw.

**Why.** JSI has no detach API, and Hermes does not export `JSArrayBuffer::detach`
— we checked the dynamic symbol table, it is one of roughly 302 exported symbols
and detach is not among them. ES2024's `ArrayBuffer.prototype.transfer` is not
implemented in Hermes either. So the buffer cannot actually be neutered; we can
only refuse to participate in its reuse.

**What it costs you.** Use-after-transfer is a data race rather than a thrown
error, unless you opt into the guard. Even with the guard on, indexed access
through a view created *before* the transfer cannot be intercepted — that needs a
`Proxy` per view, which would tax every element access.

**What would remove it.** Any one of: a JSI `detachArrayBuffer` hook; Hermes
exporting `JSArrayBuffer::detach`; or Hermes implementing
`ArrayBuffer.prototype.transfer`. With real detach, the side table, the composed
getter and the entire guard delete themselves.

## `createTransferableBuffer`

**What we do.** Provide a global that returns an `ArrayBuffer` backed by a store we
own, and document that transferring one of those is zero-copy while transferring a
plain `new ArrayBuffer(n)` copies once.

**Why.** Hermes only hands back the backing store of an *external* buffer — one
created through `createArrayBuffer(MutableBuffer)`. For an engine-internal buffer
it returns `nullptr`, so the first hop has to copy.

**What it costs you.** An unfamiliar allocation function in the hot path, and a
performance cliff that depends on where the buffer was born rather than on what you
do with it.

**What would remove it.** Hermes exposing the store of internal `ArrayBuffer`s, or
`jsi::Runtime::tryGetMutableBuffer` succeeding for them. (`tryGetMutableBuffer`
exists from RN 0.86; on 0.81–0.85 we detect it with a template probe, which is why
the codec is templated on the runtime type at all.)

## A per-worker device-event emitter (Android)

**What we do.** `WorkerReactContext.getJSModule()` returns a `java.lang.reflect.Proxy`
implementing whichever `RCTDeviceEventEmitter` interface the caller asked for,
matched **by simple name**, and marshals the event straight into the worker's own
`global.__rctDeviceEventEmitter`.

**Why.** Two things at once. First, `ReactContext.emitDeviceEvent` resolves the
emitter through `getJSModule`, and left alone that dispatches a worker module's
events on the *host* runtime — then copies them back out to the worker. That is a
JS-thread round trip plus a structured-clone copy for every event, including every
chunk of an HTTP response. Second, RN moved the interface: 0.81–0.85 ask for
`DeviceEventManagerModule.RCTDeviceEventEmitter`, 0.86 asks for
`ReactContext.RCTDeviceEventEmitter`, and the two are distinct types. Implementing
either one statically fails `isInstance` on the versions that ask for the other —
silently, with the events simply going elsewhere.

**What it costs you.** A reflective proxy on the event path, and a name-matching
rule that would not notice a *renamed* interface until events stopped arriving.

**What would remove it.** A stable, public emitter interface that does not move
between packages — or, better, `ReactContext` exposing an overridable hook for
"where do device events for this context go".

## A worker-local `ReactContext` (Android)

**What we do.** Every worker gets a `WorkerReactContext` that reports **that
worker's** `javaScriptContextHolder`, `jsCallInvokerHolder`, `runtimeExecutor`, JS
queue, native-modules queue, and peer modules — delegating everything else to the
host context.

**Why.** The common library idiom is `install(context.javaScriptContextHolder.get(),
context.jsCallInvokerHolder)`, which assumes one runtime per app. Handed the host
context, a library installs its JSI bindings onto the *host* global and then fails
its own `isLoaded()` check inside the worker. The queue and peer-module accessors
are the same story: answered by the host, a worker module asserts against the
host's NativeModules thread and reaches the host's instance of its peer.

**What it costs you.** A parallel context implementation that has to track what RN
adds to `ReactContext` — see the next entry.

**What would remove it.** First-class multi-runtime support in RN: a module
registry and queue configuration scoped per runtime rather than per app.

## Version-selected Kotlin source sets

**What we do.** `WorkerReactContext` is abstract; the concrete subclass lives in
either `src/rn87/java` or `src/rnLegacy/java`, and `build.gradle` picks one by
resolving the consumer's React Native version.

**Why.** RN 0.87 added an abstract `ReactContext.getRuntimeExecutor()`. A subclass
that overrides it fails to compile on 0.81–0.86; one that doesn't fails to compile
on 0.87.

**What it costs you.** Nothing at runtime. It costs *us* a build-time version probe
that silently defaults to the legacy variant if it can't resolve a version.

**What would remove it.** New members on `ReactContext` arriving with a default
implementation rather than as `abstract`.

## Reflection into Expo's installer

**What we do.** On Android, `installJsiForWorkerRuntime()` tries SDK 57's
`MainRuntimeInstaller(runtime).install(ptr, executor)`, falls back to SDK 54–56's
`JSIContext().installJSIForBridgeless(...)`, and **no-ops gracefully** on an
unknown future API. On iOS we allocate Expo's runtime class by name
(`NSClassFromString("EXRuntime")`) because `ExpoRuntime` is a `final` Swift class
with no ObjC header.

**Why.** Expo has moved its JSI surface twice since SDK 54, and none of these are
public API for "install into a runtime that isn't the app's main one".

**What it costs you.** On an SDK we haven't seen, `global.expo` is absent in the
worker and the build stays green — a silent degrade, logged but not fatal. That
trade is deliberate: the alternative is refusing to compile against a newer Expo.

**What would remove it.** A supported Expo API for building an `AppContext` bound
to a caller-provided runtime. The pieces exist internally; they are just not
public.

:::note[Expo SDK 56+ on iOS uses the forwarding installer]
On SDK 56+, `AppContext._runtime` became private and was replaced by a public
`setRuntime(_:scheduler:dispatch:)`. Adopting it would give those SDKs a real
per-worker `AppContext`; until that is done and device-verified per SDK, iOS
SDK 56+ falls back to the forwarding installer, where module JS objects live on
the main runtime. Android is unaffected — it builds a real per-worker `AppContext`
on every SDK.
:::

## Hand-building `RCTNetworking` and `RCTImageLoader` (iOS)

**What we do.** The worker's TurboModule delegate special-cases exactly these two
classes and constructs them with the same dependency-provider blocks
`RCTAppSetupUtils` uses, resolved from the *worker's* module registry.

**Why.** Both take their dependency lists through initializer injection and fall
back to `self.bridge` — and bridgeless has no bridge. The host app never notices
because `RCTAppSetupUtils` injects them on its behalf. A worker that built them
with `[moduleClass new]` got an empty handler list, which is why XHR and `fetch`
inside an iOS worker failed with *"No suitable URL request handler found"* until
recently.

**What it costs you.** A copy of RN's list that has to be kept in step with it. If
RN adds a third such module, a worker gets a broken instance of it and we find out
from a bug report.

**What would remove it.** RN exposing the setup path as public API — the
`RCTAppSetupDefaultModuleFromClass` logic is exactly right, it just isn't reachable
— or those modules resolving their dependencies from the module registry
themselves.

## Linker-retention anchors

**What we do.** Installers that would otherwise be reached only through a
`+load`/`__attribute__((constructor))` are called explicitly from a symbol that is
always referenced.

**Why.** A static archive drops object files nothing references, taking their
constructors with them. We shipped this bug twice: an autorelease-pool fix that
linked out and let the same crash return byte-for-byte identical.

**What it costs you.** Nothing, once it works. It cost us two debugging cycles,
because a green build says nothing about whether your code is in the binary.

**What would remove it.** Nothing upstream — this is how static linking works. It
is here so the pattern is recognisable if you see a similar file.

## Worker module denylist

**What we do.** Certain modules are never constructed inside a worker (the UI
manager and friends), and `getFabricUIManager()` returns `null` there.

**Why.** A worker is headless by design and those modules assume the main runtime
and the RN JS thread.

**What it costs you.** A `getEnforcing()` for one of them fails inside a worker
rather than returning something subtly broken. We think loud is right here.

**What would remove it.** Nothing — this one is intentional and will stay.

## Test-harness only: the `fmt` patch

**What we do.** The compatibility matrix rewrites `FMT_CONSTEVAL` in the *scaffolded
test app's* fmt headers when building RN 0.81/0.82 on iOS.

**Why.** Those versions vendor an fmt whose format-string check is `consteval`,
which Xcode ≥ 26.2 rejects. Without the patch the two oldest supported versions
cannot be built on a current toolchain, which would leave them permanently
unverified on iOS.

**What it costs you.** Nothing — this never runs in your app, only in
`.matrix/` scaffolds. It does **not** make RN 0.81/0.82 buildable for you: on those
versions you still need Xcode ≤ 26.1.

**What would remove it.** RN 0.81/0.82 backporting a newer fmt, which is unlikely
for versions that old. Realistically this disappears when those versions leave our
support range.

---

## Things people assume are hacks but aren't

- **`RN$Bridgeless = true` in a worker.** Workers genuinely are bridgeless, like
  the host. The flag makes `TurboModuleBinding::install` provide the
  `nativeModuleProxy` that serves both TurboModules and legacy modules.
- **The worker's own native-modules queue.** This mirrors what RN does on the host,
  where module methods run on the NativeModules queue rather than the JS thread.
  Running them inline on the worker's JS thread was the anomaly.
- **`RCTModuleRegistry` pointed at the worker's `TurboModuleManager`.** That is the
  sanctioned API (`setTurboModuleRegistry`), used exactly as intended.
