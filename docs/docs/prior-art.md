---
sidebar_position: 11
title: Prior Art & Comparison
slug: /prior-art
---

# Prior Art & Comparison

`react-native-workers` did not appear in a vacuum. Running JavaScript off React
Native's single JS thread is a problem the community has been chipping away at
for nearly a decade, and this library owes a real debt to the projects that came
before it — Software Mansion's worklets work in particular reshaped what people
believe is possible in React Native. This page explains where each project sits,
what it is genuinely best at, and why I think a Web Worker–shaped library still
deserves a place alongside them.

Everything below is based on reading the actual source of each library
(`react-native-worklets` 0.11.3, `react-native-worklets-core` 1.6.3,
`@react-native-runtimes/core` 0.1.0-alpha.0, plus the historical
`react-native-threads` and `react-native-multithreading`), not just their
READMEs. These projects move fast — if I've misrepresented anything, or if a
row has gone stale, please open an issue; I'd rather be corrected than
flattering.

:::note[Corrected after feedback from the Worklets team]
Tomasz Żeliszewski of Software Mansion [went through an earlier version of this
page in detail](https://x.com/tjzeldev/status/2081673853831430226) and corrected
several things I had wrong — about worklet runtimes having event loops and timers
from the start, about Bundle Mode's import story, about worklet runtimes already
being movable between threads, and, most importantly, about native modules inside
a worker not being as isolated as I implied.

He was right, and the page has been rewritten accordingly. The native-module point
was the substantive one and it took real work to fix rather than reword —
[what changed is written up below](#what-the-worklets-team-corrected-me-on). I'm
grateful for the review; it made the library better, not just the page.
:::

## The landscape at a glance

Three mental models exist today for multithreaded JavaScript in React Native:

1. **Worklets** — small functions, marked with a `'worklet'` directive, that a
   Babel plugin extracts (code string + captured closure) and re-evaluates
   inside another runtime. Pioneered by Software Mansion for Reanimated;
   reimplemented by Margelo as `react-native-worklets-core` for VisionCamera
   and friends.
2. **Full app runtimes** — the *entire app bundle* loaded again into a second
   React Native instance, which can even render its own UI surfaces. This is
   `react-native-runtimes`.
3. **Workers** — a separate file, compiled into its own small bundle, running in
   its own engine on its own thread, speaking `postMessage`. This is the Web
   Worker model, and it's what `react-native-workers` implements.

These are not competitors so much as different points on a spectrum of *how
much environment travels with your code*: a worklet carries only its closure; a
worker carries its own module graph; a runtime carries the whole app. Each
point is the right one for somebody.

## Comparison table

| | **react-native-workers** | **react-native-worklets** (Software Mansion) | **react-native-worklets-core** (Margelo) | **react-native-runtimes** (Margelo) |
|---|---|---|---|---|
| Unit of concurrency | A worker: separate file, own Metro bundle graph, own Hermes runtime + thread | A worklet: `'worklet'`-directive function, stringified by Babel, eval'd in another runtime | Same worklet model (`'worklet'` directive + Babel plugin) | A named runtime: the *whole app bundle* loaded into a second RN instance on its own thread |
| API shape | Web Worker standard: `new Worker()`, `postMessage`, `onmessage`, `self`, `terminate` | Custom: `scheduleOnUI`, `createWorkletRuntime`, `scheduleOnRuntime`, `scheduleOnRN` | Custom: `Worklets.createContext`, `context.runAsync`, `runOnJS` | Custom: `<OnRuntime>`, `ThreadedRuntime.prewarm`, `runtimeFunction`, headless tasks |
| Babel plugin | One line, only rewrites `new Worker('./path')` to a bundle reference | Required; transforms every worklet function, closure capture rules apply | Required; same, plus auto-workletization config | Required Metro transformer + Babel plugin; generates entry files, rewrites `OnRuntime` children and directive-marked functions |
| npm imports in the other thread | ✅ Normal ES imports, resolved at bundle time | ⚠️ Not in the default (eval) mode; **Bundle Mode** enables it and now ships its own Metro wrapper (`react-native-worklets/bundleMode`) instead of hand-patched Metro — still opt-in | ❌ Only closure-captured values + injected globals | ✅ Same bundle, whole module graph present |
| Timers inside | `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask` + microtask loop | Same — an event loop and timers are there from the start, and a runtime can be created *without* them when the host provides its own cadence | `setImmediate` only (no `setTimeout`/`setInterval`) | Full RN environment |
| `fetch`/network inside | Via the worker's bundle (standard Metro shim provides `XMLHttpRequest`/`Blob`/`FormData`), running off the RN JS thread | Bundle Mode ships a `fetch` written from scratch that runs truly off the JS thread (behind a feature flag) | ❌ | ✅ |
| Native modules inside | ✅ C++ TurboModules by default; platform (Java/ObjC) modules opt-in per worker, with events and method bodies staying on the worker — [see the isolation rules](#what-the-worklets-team-corrected-me-on) | ❌ (not the goal) | ❌ (host objects can be injected per-context via `addDecorator`) | ✅ It's a real RN instance: iOS resolves through the app's RN delegate; on Android you hand it a package provider once (`setMainReactPackagesProvider` for the app's full set, `setExtraReactPackagesProvider` for extras) |
| Expo modules inside | ✅ `requireNativeModule(...)` works in a worker on both platforms (functions, events, live properties) | ❌ | ❌ | ⚠️ Not documented; would follow from the runtime's package set |
| Data passing | Structured clone (binary codec): cycles, `Date`, `Map`, `Set`, `RegExp`, `Error`, `BigInt`, `ArrayBuffer`, TypedArrays; `DataCloneError` on functions | `createSerializable`: very broad (Map, Set, RegExp, Error, functions-as-remotes, TypedArrays); cycles throw; captured objects frozen in dev | JSI wrappers; primitives copied, arrays/objects as C++ proxies | JSON only: `Date`/`Map`/`Set` → `{}`, cycles throw |
| Zero-copy binary handoff | ✅ Transfer list moves the backing store (`createTransferableBuffer` for a no-copy-ever buffer) — but Hermes has no real detach, so [the neutering is simulated](/docs/compat-seams#simulated-arraybuffer-transfer) | Postponed — transferable `ArrayBuffer`s ran into threading/GC issues in Hermes | ❌ | ❌ (JSON boundary) |
| Shared state | `SharedStore` (subscribable tree), `SharedValue` (sync cell), `SharedBuffer` (raw shared memory + lock), `reactive()` proxy | `Synchronizable` (locking cell), `Shareable` (host/guest object) — shared *values* live up in Reanimated | `SharedValue` (thread-safe, proxy-wrapped objects) | `@react-native-runtimes/state`: shared Zustand-style store, sync reads, JSON at the boundary |
| Typed RPC between threads | ✅ `defineModule` / JSModule bridge: one typed contract, promises, events both ways, `$ready` | ❌ (schedule functions; return via Promise variants) | ❌ (Promise return values) | ⚠️ `runtimeFunction` + `call().on()` (JSON args/returns) |
| Runtime on the platform main thread | ✅ `UIWorker` — a full worker runtime on the UI thread, shared and persistent by default | ✅ The UI runtime — the model everything else is built around | ❌ Contexts are background threads; the "default" context is the React-JS one | ❌ (the point is the *opposite*: move a runtime **off** the main thread) |
| Move an existing runtime onto another thread | ✅ `Thread` (experimental), from JS: the *same* runtime executes a callback on the main thread or a named background thread — no serialization, closures and object identity intact | ✅ via the C++ API — Reanimated has juggled the UI worklet runtime between threads for years; not exposed as a JS-level API | ❌ | ❌ |
| Can render UI on another thread | ❌ (headless by design) | ❌ (drives the UI thread's animation runtime, not React rendering) | ❌ | ✅ Fabric surfaces mounted on secondary runtimes — its headline feature |
| Sync cross-thread calls | Sync shared reads (`SharedValue.value`, `SharedStore`), async calls | ✅ `runOnUISync`, `runOnRuntimeSync` — genuinely unique | ❌ (async only; sync shared-value reads) | Sync shared-store reads; async calls |
| Debugging | Each worker is its own DevTools target; console forwarded to host with a `[Worker:name]` tag | Worklet stack symbolication; shared DevTools story | Console forwarded via `runOnJS` | Multiple JS targets in DevTools; stack traces don't cross runtimes |
| Per-thread cost | Hermes runtime + ~150 KB shimmed bundle, Hermes-bytecode-compiled in release so there's no parse step (configurable heap cap) | Bare worklet runtime — the lightest option here | Bare worklet runtime | Full RN boot: Hermes + whole-bundle parse + module init (mitigated by prewarm) |
| RN requirements | 0.81.4+, New Architecture, Hermes (compat matrix builds 0.81–0.86 + `latest`/`next` on every run) | 0.83–0.86 for the current 0.11.x line (0.8.x covers 0.81–0.85), New Architecture | Old & New Architecture (JSI installer) | 0.76+, New Architecture, Hermes, Nitro Modules |
| Maturity | Alpha, but feature-complete for its scope: dev **and** release file workers, inline workers, Expo, and native modules all work on both platforms | Stable core (powers Reanimated 4); Bundle Mode opt-in | Stable; positioned as infrastructure for other libraries | Early alpha (0.1.0-alpha.0) |

And the two historical projects that deserve credit for getting here first:

- **`react-native-threads`** (2017–2020) proved the separate-file, Web
  Worker–shaped model people actually wanted — `new Thread('./worker.js')`,
  `postMessage`, `self.onmessage`. But it predated JSI, so each "thread" was a
  full RN process communicating in **strings only** over the bridge. Unmaintained
  since 2020.
- **`react-native-multithreading`** (2021–2022) was Marc Rousavy's
  proof-of-concept `spawnThread(fn)` built on Reanimated 2 worklets — the first
  taste of inline functions on a real parallel JSI runtime. Its README says
  plainly: *"This is a proof of concept. Do not use this library in
  production."*

`react-native-workers` is, in a sense, what `react-native-threads` wanted to be
once JSI, Hermes, and the New Architecture made it possible to do properly:
same standard API, but real threads in one process, structured clone instead of
strings, and native modules that work.

## What the Worklets team corrected me on

This section exists because an earlier version of this page overclaimed, and the
correction was worth more than the claim.

### "Native modules work in a worker" was too strong

The objection, paraphrased: React Native's native modules are tied to the main RN
runtime. Their events are emitted on it. So a worker's HTTP request completes on
the RN JS thread and gets forwarded — meaning a busy JS thread starves your worker
anyway. And native modules generally aren't thread-safe, because they were written
assuming one runtime on one thread.

**Every part of that was accurate when it was written.** Worker module events were
raised on the host runtime and copied out to interested workers, so a worker's
network response really did depend on the host JS thread being free.

I treated it as a bug report. Two rules are now enforced, and the second is the
one that objection is about:

1. A worker runtime never blocks the host runtime or the RN JS thread.
2. A worker's native modules stay on that worker — its own event system, its own
   module instances, no contamination of the main thread.

Concretely, on **Android**: a worker serves its own device-event emitter, so a
module's events are marshalled straight into that worker's
`global.__rctDeviceEventEmitter` without ever touching the host runtime; module
method bodies run on a per-worker native queue instead of inline on the worker's JS
thread (mirroring what RN does on the host); and peer-module lookups resolve
through the worker's own registry rather than handing back the host's instances.

On **iOS**: the worker's `RCTCallableJSModules` routes device events into that
worker's emitter, and its module registry resolves peers within the worker. Fixing
that turned up a related bug worth admitting — `RCTNetworking` in a worker had an
*empty* URL-handler list, so XHR and `fetch` inside an iOS worker had never worked
at all. That is fixed, along with the same defect in `RCTImageLoader`.

The claim is now tested rather than asserted. The suite pins the host JS thread in
a busy loop and requires a worker's HTTP request to complete anyway; a separate
test watches the host's device-event stream during a worker's request and requires
that **none** of that request's events were dispatched on the host runtime.

### What is still true from the objection

- **Thread-safety is still the module's business.** Nothing here makes a module
  that assumes one runtime on one thread suddenly safe on two. A worker gets its
  own instance where the module's design allows, but a module holding process-wide
  mutable state without a lock is still a hazard. Platform modules are therefore
  opt-in per worker (`{ nativeModules: true }`), not on by default.
- **I deny some modules outright** rather than pretend — the UI manager and its
  neighbours are never constructed inside a worker.
- **Everything above is version-sensitive**, and the seams that keep it working
  across RN and Expo versions are listed in
  [Hacks & compatibility seams](/docs/compat-seams).

### The other corrections

- **Worklet runtimes are not bare.** They have an event loop and timers from the
  start, and can be created deliberately *without* them when the host supplies its
  own cadence (as `react-native-audio-api` does). My earlier "no imports, no
  `fetch`, not even `setTimeout`" described `worklets-core`, and I let it colour
  the description of `react-native-worklets` too. Corrected in the table above.
- **Bundle Mode imports any library**, and its `fetch` is written from scratch
  specifically so it runs off the JS thread — the same problem I was solving,
  solved independently and, at the time, more honestly than I had.
- **Worklet runtimes already move between threads** through the C++ API; Reanimated
  has done it with the UI runtime for years. My `Thread` is a JS-level API for
  that idea, not the idea itself.
- **A worklet on a dedicated runtime is close to a Web Worker already** — minus the
  `postMessage`/`onmessage` surface. That is a fair characterisation and the table
  should not have implied otherwise.

### On the offer to collaborate

Tomasz ended by suggesting the two projects could integrate rather than compete —
Worklets providing battle-tested low-level abstractions, Workers providing the
familiar high-level API. I think that's the right read, and the section below on
[building other models on top](#flexible-enough-to-build-the-others-on-top) was
written before the exchange with exactly that shape in mind. The door is open, and
I'd rather build on their work than around it.

## Where the others are genuinely better

I want this page to be trustworthy, so let's start with the cases where you
should *not* pick this library.

- **Animations and gestures: use Reanimated / `react-native-worklets`.**
  Software Mansion's synchronous UI-runtime pipeline (`runOnUISync`,
  frame-accurate `requestAnimationFrame`, shared values wired into the
  renderer) is purpose-built and battle-tested for driving UI at 60–120 fps.
  A message-passing worker cannot and should not compete on that turf.
- **Frame processors and C++ library integration: `react-native-worklets-core`.**
  Its C++-first design — create a context, hand a `jsi::Function` to any native
  thread, invoke per frame — is exactly right for VisionCamera-style hot paths
  where the *native side* owns the cadence.
- **Moving an entire heavy screen off the main runtime: `react-native-runtimes`.**
  Rendering real Fabric surfaces from a secondary runtime is its headline
  capability and nothing else on this page does it. If your problem is "this
  chat list monopolizes my JS thread and I want it on another one, UI and all,"
  that is the tool shaped like your problem. It also gets native modules for
  free in a way I have to work for: a secondary runtime is a real RN instance,
  so on iOS it resolves modules through the app's own delegate and on Android
  you hand it a package provider once.

## Where react-native-workers fits

### You already know the API

Every JavaScript developer has seen this code:

```js
const worker = new Worker('./workers/heavy-task');
worker.postMessage(data);
worker.onmessage = (e) => setResult(e.data);
```

There is nothing to learn, no directive to remember, no mental model of "which
closure variables get frozen and copied." The worker surface here follows the
Web spec closely — `self`, `addEventListener`, `MessageEvent`, `ErrorEvent`,
`structuredClone`, buffered message delivery before a handler attaches, errors
propagating to `onerror`. Code written for a web worker has a fighting chance
of running unmodified, and knowledge transfers in both directions.

The worklet libraries, by necessity, invented their own vocabulary
(`scheduleOnUI`, `createRunAsync`, `__closure`), and their Babel plugins impose
real rules: worklets can't call un-workletized functions, captured objects are
frozen in dev, cyclic captures throw, and the allow-list of usable globals is
finite. These are reasonable engineering trade-offs for their goals — but they
are things you have to *know*, and the error messages become part of your
onboarding. My Babel plugin, by contrast, does one mechanical thing: it turns
`new Worker('./path')` into a reference to a separately-bundled file.

### Your worker is a real JavaScript environment

Because each worker is its own Metro bundle graph, you write a worker the way
you write any module: `import` what you need — your own utilities, npm
packages, a database client — and it's just there. Inside, you get timers,
microtasks, promises, `console`, and (opt-in per worker) actual TurboModules,
with events delivered on the worker's own thread. Expo apps are covered too:
`requireNativeModule(...)` works inside a worker on both iOS and Android, with
functions, events, and live properties going through Expo's own native paths.
The README's framing is accurate to the implementation: a worker is *a headless
React Native — no UI, but the same engine, the same timers and Promises, and
the same native modules*.

A worklet runtime is not bare — it has an event loop and timers from the start,
and Bundle Mode lets you import any library into one, with a `fetch` written from
scratch so that requests run genuinely off the JS thread. The difference is where
each project starts: Bundle Mode is opt-in on top of a model whose default unit is
a stringified function plus its closure, and I started from full-environment-first
because "run my existing parsing/crypto/database code on another thread" was the
problem I cared about. (`worklets-core` is the genuinely minimal one: no
`setTimeout`, no imports, closure-captured values and injected globals only.)

`react-native-runtimes` also gives you a full environment — the fullest
possible, since it's your whole app bundle. The trade is cost and coupling:
every runtime pays a complete React Native boot (Hermes instance, full bundle
parse, module init — hence its prewarming API), and everything crossing the
boundary is `JSON.stringify`'d, so `Date` and `Map` silently become `{}`. A
worker here boots a ~150 KB shimmed bundle into a capped-heap Hermes runtime —
Hermes-bytecode-compiled in release builds, so there's no parse step at all —
and messages are structured-cloned by a binary codec that preserves cycles,
`Date`, `Map`, `Set`, `RegExp`, `Error`, `BigInt`, `ArrayBuffer`, and TypedArrays.

### Communication is a ladder, not a single rung

Real apps need more than one communication pattern, and forcing everything
through one primitive is where DX usually breaks down. This library
deliberately gives you a graduated set:

- `postMessage` — structured clone, the spec default;
- `defineModule` — one typed TypeScript contract that both sides implement:
  promise-returning methods, events in both directions, readiness handshakes,
  and clean `WorkerTerminatedError` rejection on teardown;
- `SharedStore` — a subscribable state tree visible to every thread;
- `SharedValue` — a synchronous single cell (lock-free for numbers);
- `SharedBuffer` — raw shared memory with an explicit named lock when you want
  zero-copy bulk numeric data.

You pick the cost you want to pay. The typed RPC layer in particular has no
real equivalent elsewhere: `runtimeFunction` in `react-native-runtimes` covers
calls (through JSON), and the worklet libraries cover scheduling, but nobody
else gives you a single typed contract with methods, bidirectional events, and
lifecycle semantics out of the box.

### A runtime can visit another thread

Every model on this page assumes *runtime and thread are welded together*: to
run code somewhere else, you move the code (worklets), the message (workers), or
the whole app (runtimes) — and whatever your code closed over gets left behind,
copied, or re-created.

[`Thread`](./guides/threads) is the exception. It lets a worker's **own runtime**
temporarily execute on a different OS thread — the main thread, or a background
thread you name — with nothing serialized:

```js
enableMultiThreadingExperimental();

const codec = Thread.create('codec');

await codec.run(() => {
  const pixels = decodeFrame(bytes);   // on the 'codec' thread
  Thread.main.run(() => applyToNativeView(pixels));  // on the main thread
});
```

The callback is a plain closure. The same variables, the same `Map`, the same
object identity — only the executing thread changes. A per-worker lock keeps one
thread inside the runtime at a time, so this buys **thread affinity**, not
parallelism: it's for work that must happen *on a particular thread* (a native
API that demands the main thread, a library that wants its own) while sharing the
worker's live state.

This is explicitly experimental and off until you call
`enableMultiThreadingExperimental()` — the rules around it (atomic callback
bodies, no synchronous waits, long callbacks block) are worth reading before
shipping it. But no other library here offers the shape at all, and it's the
clearest illustration of what "unopinionated substrate" buys you.

### Each worker is honestly debuggable

Every worker registers as its own DevTools target, and its console output is
also forwarded to the host tagged `[Worker:name]`. Eval'd worklet strings have
historically been the hard case for debugging (Software Mansion has invested
real effort in stack symbolication to compensate); separate bundles with
ordinary source maps sidestep the problem.

## Flexible enough to build the others on top

A claim worth making carefully: the worker substrate is *lower-level* than the
worklet and runtime models, so their APIs can largely be expressed on top of
it — the reverse is not true.

**A worklets-style API** is a Babel transform plus an evaluation target plus
shared cells — and all three exist here. Workers accept inline source
(`new Worker({ inline })`), `UIWorker` provides a persistent runtime *on the
platform main thread* (the same placement as the worklets UI runtime, on both
iOS and Android), and `SharedValue` gives synchronous cross-thread cells with
subscriptions. A plugin that stringifies a `'worklet'` function and its
captured closure — exactly what the existing worklet plugins do — could target
a `UIWorker` or background worker and reproduce `scheduleOnUI` /
`scheduleOnRuntime` semantics as a userland library, no native code required.
`Thread` adds a second route to the same place: rather than shipping a worklet
*to* the UI thread, a worker can take its runtime there for the duration of a
callback. What you could *not* reproduce without new native work is Software
Mansion's synchronous call machinery (`runOnUISync`) or Reanimated's renderer
integration — I'd rather be honest that those remain their moat.

**A runtimes-style business layer** maps even more directly. Strip
`react-native-runtimes` of its (excellent, and out of scope for me) Fabric
surface hosting, and its remaining surface — `prewarmBusinessRuntime`, headless
tasks, `runtimeFunction`, the shared store — corresponds one-to-one to
long-lived named workers, `postMessage`, `defineModule`, and `SharedStore`,
with structured clone instead of JSON at every boundary. There is also a
C++ facade (`NativeWorkers`) for creating and driving workers from any native
thread, which is the hook a higher-level framework — or a VisionCamera-style
native integration — would build against.

That direction of flexibility is the core of the argument for this library's
place in the ecosystem: worklets and app-runtimes are both *opinionated
framings* of multithreading, optimized for animations and for threaded UI
respectively. A spec-shaped worker with real bundles, structured clone, shared
memory, and typed RPC is the *unopinionated substrate* underneath both
framings — useful directly for the everyday "get this work off my JS thread"
case, and a foundation when you need to build something more opinionated.

## Honest limitations

Symmetry demands I list my own caveats as plainly as everyone else's:

- This is an **alpha**. The surface is feature-complete for its scope and
  exercised by a compat matrix that rebuilds the library against every supported
  RN and Expo version, but it has not been through a wide production shakedown
  the way Reanimated's runtime has.
- **Transfer is simulated, not enforced by the engine.** The transfer list really
  does move the backing store, but Hermes has no `ArrayBuffer` detach, so a
  transferred buffer is only neutered by the library's own bookkeeping: the message path
  refuses to reuse it and `.detached` reports `true`, while raw reads still
  succeed unless you opt into `enableTransferGuard()`. `SharedArrayBuffer` does not
  exist in Hermes; `SharedBuffer` is the supported shared-memory path. The full
  reasoning is in [Hacks & compatibility seams](/docs/compat-seams).
- **Native-module isolation depends on private RN internals.** It works, and it is
  tested on both platforms, but it rests on version-sensitive seams (a reflective
  event-emitter proxy, a worker-local `ReactContext`, hand-built `RCTNetworking`
  and `RCTImageLoader`). A future RN version can move one of those; the compat
  matrix is how I find out.
- **Expo modules on iOS SDK 56+ still use the forwarding installer**, so those
  module objects live on the main runtime. Android builds a real per-worker
  `AppContext` on every SDK.
- **Thread-safety of a given native module is still its own business** — a worker
  gets its own instance where the module allows, but nothing here makes a module
  written for one runtime safe on two.
- No synchronous cross-thread *calls* — synchronous access is via the shared
  primitives, calls are async.
- `Thread` is experimental and opt-in, and gives thread affinity rather than
  parallelism (one thread inside a runtime at a time).
- Requires React Native 0.81.4+ with the New Architecture and Hermes, like most
  of its modern peers.
- Web support is a compatibility fallback (delegates to the browser's real
  `Worker`), not a first-class target.

## Standing on shoulders

Software Mansion normalized the idea that React Native apps can run JavaScript
on multiple threads at all, and their worklet runtime remains the gold standard
for its domain. Margelo generalized worklets into reusable infrastructure and
is now exploring the bold whole-app-runtime end of the spectrum. Joltup's
`react-native-threads` showed years earlier that developers wanted the Web
Worker shape. `react-native-workers` tries to honor all of that by filling the
point on the spectrum that was still empty: the boring, standard,
spec-shaped worker — with a real JavaScript environment inside and a modern
data-sharing story around it.
