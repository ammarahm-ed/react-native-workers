---
slug: introducing-react-native-workers
title: 'react-native-workers 1.0.0-alpha: real multithreading for React Native'
authors: [ammar]
tags: [release, announcement, alpha]
image: /img/workers-social-card.png
---

import DeviceFrame, { Showcase } from '@site/src/components/DeviceFrame';

React Native has always been single-threaded where it matters most. Your JavaScript
runs on one thread, and anything heavy you do there — parsing a big payload, hashing,
compression, image work, a chatty reducer, a busy render — competes with the UI for
the same runtime. The usual advice is "move it native," but that means writing a
native module for every heavy thing you'd rather just write in JS.

**react-native-workers** brings the Web's answer to this problem to React Native:
real background threads, each with its own JavaScript runtime, behind the `Worker`
API you already know from the browser. Today it enters **public alpha** as
`1.0.0-alpha`.

This post is the full tour — what it is, how it's built, everything it can do
(including some things a worker library usually can't), how hard it's been tested,
what's still rough, and where it's going.

<Showcase>
  <DeviceFrame
    width={262}
    video="/img/video/imagefx.mp4"
    alt="The example app applying invert, sepia and pixelate filters to an image; each run reports the filter time and the worst UI frame gap"
    caption={<>Image filters running in a worker on pixels held in a <code>SharedBuffer</code>. Each run reports the worst UI frame gap it caused — one frame, while a 250&nbsp;ms blur runs.</>}
  />
  <DeviceFrame
    width={262}
    src="/img/screens/parse.webp"
    alt="Parallel parse screen: 120,000 log lines parsed by 1, 2, 4 and 8 workers, taking 54ms, 29ms, 18ms and 17ms — a 3.18× speedup"
    caption={<>The same 2.58&nbsp;MB of logs parsed by 1, 2, 4 and 8 nested workers over one shared buffer — 54&nbsp;ms down to 17&nbsp;ms.</>}
  />
</Showcase>

{/* truncate */}

## The shape of it

If you've used a Web Worker, there's nothing new to learn:

```js
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker('./workers/heavy');
worker.onmessage = (e) => console.log('result:', e.data);
worker.postMessage({ items: 100_000 }); // returns instantly; runs off the UI thread
```

```js
// workers/heavy.js — a normal module that runs on its own thread
self.onmessage = (e) => {
  const total = expensiveWork(e.data.items); // never blocks the UI
  self.postMessage(total);
};
```

That's the shape; for a real one, the [parallel-parsing tutorial](/docs/tutorials/parallel-parse)
moves JSON parsing off the UI thread step by step. A worker takes a couple of options
that are worth knowing up front:

```js
const worker = new Worker('./workers/importer', {
  nativeModules: true, // let the worker reach the app's native modules (more below)
  maxHeapMb: 512,      // per-worker Hermes heap cap (default 256)
  inspectable: true,   // allow a Hermes debugger to attach to this worker
});
```

Call `worker.terminate()` when you're done and the whole runtime + thread goes away.
Everything else — `postMessage`, `onmessage`, `onerror`, nested workers — behaves the
way you'd expect coming from the browser.

### Inline workers, when a file is overkill

For a one-off or a dynamically generated worker, skip the file and pass source
directly. Inline workers need no Babel plugin and no bundling step — which also makes
them the path that works everywhere today (more on that in [What "alpha" means](#what-alpha-means)):

```js
const doubler = new Worker({
  inline: `self.onmessage = (e) => self.postMessage(e.data * 2);`,
});
```

### When something throws

Errors in a worker don't crash your app — they surface on `onerror`, with the source
location carried across the thread boundary:

```js
worker.onerror = (e) => {
  console.log(e.message, 'at', e.filename, ':', e.lineno);
};
```

## It's not built on Worklets — each worker is a full runtime

A common first question: *is this Reanimated/Worklets under the hood?* It isn't, and
the difference is the whole point.

react-native-workers spins up a **separate Hermes runtime on its own OS thread** for
each worker, with its own event loop, its own bundle, and full `import` support.
That's the Web Worker model: real, independent runtimes that talk over messages.

Worklets are a different tool — they run serialized closures on a *shared* runtime
with shared values, which is perfect for driving animations but isn't a place to run a
whole module graph. react-native-workers runs **alongside** worklets; it's for the "I
have real work to do off the main thread" case.

## Under the hood

It helps to know what actually happens when you write `new Worker('./workers/heavy')`:

- **A fresh Hermes runtime is created on a dedicated thread** (via
  `hermes::makeHermesRuntime`). Nothing is shared implicitly — the worker has its own
  globals, its own module registry, its own garbage collector, capped by `maxHeapMb`.
- **Worker files are compiled into their own bundles.** A Metro transformer picks up
  each `new Worker('./path')`, bundles that module (and its imports) separately, and
  wires it to load by relative path. You write normal modules; you don't hand-manage
  bundles. Inline workers skip this entirely.
- **Messages cross via a structured-clone codec** — objects, arrays, `Date`, typed
  arrays, `ArrayBuffer`, and cycles are serialized between runtimes.
- **A per-worker `CallInvoker` keeps everything thread-consistent.** Async native work
  and promises resolve back on *the worker's own thread*, not the main one — which is
  what makes the native features below safe rather than a source of cross-thread
  crashes.

The worker's global scope is set up to feel familiar: `self`, `postMessage`,
`structuredClone`, `queueMicrotask`, a `Worker` constructor for nesting,
`NativeEventEmitter`, and the native-module accessors described next.

## Reaching the native side

A background thread that can only do pure computation is useful. A background thread
that can reach the **native side** is a different class of tool — and this is where
react-native-workers goes past a typical worker library.

### Two tiers: C++ by default, platform modules on request

There are two levels of native access, by design:

- **C++/JSI modules are available in every worker** out of the box — including this
  library's own module, which is what lets a worker create *nested* workers.
- **The app's platform (Java/Objective-C) TurboModules and legacy native modules are
  opt-in**, because they're heavier and not all of them are safe off the main thread.
  Turn them on per worker with `nativeModules: true`.

```js
const worker = new Worker('./workers/db', { nativeModules: true });
```

Worker-unsafe modules — anything that assumes the UI thread, the surface registry, and
so on — are **denylisted** so they can't be pulled into a worker by accident. On iOS
there's no setup; on Android you hand the library your package list once. The
[native modules guide](/docs/guides/native-modules) covers the model, and the
[download-manager tutorial](/docs/tutorials/transfer-manager) puts native modules to
work inside a worker end to end.

### Expo Modules, inside a worker — on iOS *and* Android

This is the one I'm most excited about. In an Expo app, `requireNativeModule(...)`
works **directly** inside a worker, across the whole module surface:

```js
// inside a worker (nativeModules: true, in an Expo app)
const Device = requireNativeModule('ExpoDevice');
Device.osName;                         // constants — read synchronously
await Device.getDeviceTypeAsync();     // async functions — invoked natively

const Crypto = requireNativeModule('ExpoCrypto');
Crypto.randomUUID();                   // sync functions — a value, not a Promise

const Foo = requireNativeModule('SomeModule');
Foo.someProperty;                      // live properties, read on access
const sub = Foo.addListener('onX', handle); // module events, delivered into the worker
sub.remove();
```

Constants, sync **and** async functions, live properties, and module events — the
whole thing, running through Expo's real implementation, with nothing crossing between
runtimes (that would crash). The two platforms get there differently, and getting both
working was most of the effort behind this release:

- On **iOS**, the Swift↔C++ boundary makes a second Expo `AppContext` impractical, so
  the library installs its own `global.expo.modules` inside the worker that **forwards
  each call natively** through Expo's public `AppContext` API — native values in,
  native values out, results delivered back on the worker thread.
- On **Android**, Expo's JNI install accepts a raw runtime pointer, so the library
  builds a genuine **per-worker Expo `AppContext`** and lets Expo install `global.expo`
  against the worker runtime directly — every feature runs through Expo's own code.

From your side, it's just `requireNativeModule`. Because these lean on Expo internals,
the version matrix (below) exists specifically to catch the day Expo changes them. The
[installation guide](/docs/installation#expo-modules-inside-a-worker) has the Expo setup,
and the repo's [Expo example](https://github.com/ammarahm-ed/react-native-workers/tree/main/expo-example)
runs a worker probe that exercises the whole surface on both platforms.

### UIWorker — drive native UI from a worker

Beyond request/response, **`UIWorker`** lets worker code render and update native
components, with events delivered natively rather than round-tripping through the main
JS thread. UIWorker runtimes are **shared and persistent** by default — asking for the
same worker twice reconnects to the already-loaded runtime instead of re-evaluating it
— with an `independent` option when you want a private, 1:1-lifetime runtime like a
background `Worker`. See the [UIWorker guide](/docs/guides/ui-worker) for the full API,
and the [UIWorker demo](/docs/tutorials/uiworker-demo) and
[native components from a worker](/docs/tutorials/worker-native-components) tutorials for
it in action.

<Showcase>
  <DeviceFrame
    width={228}
    video="/img/video/uiworker-animate.mp4"
    alt="A square view rotating at 60fps driven from a UIWorker, still animating while the app's JS thread is blocked for 2000ms"
    caption={<>A UIWorker's own 60&nbsp;fps loop writing a view's transform directly. It keeps running while the app's JS thread is blocked for two seconds.</>}
  />
  <DeviceFrame
    width={228}
    src="/img/screens/uiworker.webp"
    alt="UIWorker demo screen: 10,000 direct Obj-C calls at 0.1µs per call with onMain=true, and the same calls from a background Worker refused with an error"
    caption={<>10,000 direct UI calls at 0.1&nbsp;µs each from the main thread — and the same calls refused when they come from a background worker.</>}
  />
  <DeviceFrame
    width={228}
    src="/img/screens/nativecomponent.webp"
    alt="A live MKMapView with custom pins rendered by a view manager that was written in JavaScript and registered from a UIWorker"
    caption={<>A real <code>MKMapView</code> host component whose view manager is JavaScript, registered from inside a UIWorker — no native code, no codegen.</>}
  />
</Showcase>

## Sharing state without copying everything

Messages are great until you're moving a lot of data back and forth. So there are
shared primitives that live across runtimes — [`SharedStore`](/docs/shared-data/shared-store),
[`SharedValue`](/docs/shared-data/shared-value), and
[`SharedBuffer`](/docs/shared-data/shared-buffer) (there's an
[overview](/docs/shared-data/overview) tying them together).

### SharedStore — a cross-runtime key/value store

```js
import { SharedStore } from '@ammarahmed/react-native-workers';

const store = new SharedStore('prefs');
store.set('theme', 'dark');
const unsub = store.subscribe('theme', (v) => applyTheme(v));

// from any other runtime:
store.get('theme'); // 'dark'
```

`set` / `get` / `has` / `delete` / `keys` / `subscribe` — a small, observable store any
runtime can read, write, and watch.

### SharedValue — one shared, observable value

Handy for a progress figure or a flag that the UI wants to reflect live:

```js
import { SharedValue } from '@ammarahmed/react-native-workers';

const progress = new SharedValue('import-progress', 0);
// in the worker:
progress.value = 0.5;
// on the UI:
progress.subscribe((v) => setProgress(v));
```

<DeviceFrame
  width={280}
  video="/img/video/downloads.mp4"
  alt="Six transfer progress bars filling smoothly while a counter shows the worker made over a thousand shared writes against a few hundred rendered frames"
  caption={<>Six transfers in one worker, each writing progress into a shared cell hundreds of times a second. The UI samples the cells once per frame — the write count runs far ahead of the frame count, which is the point.</>}
/>

### SharedBuffer — raw shared memory

The zero-copy building block: a block of memory shared across runtimes, with a lock so
writers and readers don't tear:

```js
import { SharedBuffer } from '@ammarahmed/react-native-workers';

const buf = new SharedBuffer('frame', 1920 * 1080 * 4);
buf.withLock(() => {
  // write bytes here in the worker; the UI reads the same memory — no message copy
});
```

<DeviceFrame
  width={280}
  video="/img/video/sensor.mp4"
  alt="A live waveform drawn from a ring buffer in shared memory; the producer rate jumps from 163Hz to 800Hz while the screen keeps reading at about 25Hz"
  caption={<>A worker filling a ring buffer in shared memory. Halfway through, its sample rate is raised to 1000&nbsp;Hz — the reader carries on at ~25&nbsp;Hz and simply draws whatever is in the ring, with <code>withLock</code> keeping the window it copies consistent.</>}
/>

### reactive() and defineModule() — higher-level coordination

On top of the store, [**`reactive()`**](/docs/shared-data/reactive-state) gives you a
proxy-based state object that syncs across the boundary — mutate it like a plain object,
and other runtimes see the change (the [note-editor tutorial](/docs/tutorials/note-editor)
builds a whole editor on it):

```js
import { reactive } from '@ammarahmed/react-native-workers';

const state = reactive();  // a shared, observable object
state.progress = 0;        // set from the worker
state.progress += 0.1;     // mutate; the UI's subscription fires
```

And **`defineModule()`** is a small, fully-typed RPC bridge for when you'd rather call
methods than hand-roll a message protocol: from one contract you get to call host
methods from the worker, emit events **both** ways, and share reactive `state` — all
typed end to end, with a `dispose()` to tear it down. The
[defineModule guide](/docs/rpc/define-module) has the full shape.

## Running a worker's JS on *another* thread (experimental)

Everything above moves *data* between runtimes. The newest piece moves the
**thread** instead.

A worker's runtime is normally pinned to its own thread. The experimental
`Thread` API lets that same runtime temporarily execute somewhere else — the
main/UI thread, or a background thread you create:

```js
enableMultiThreadingExperimental();

const codec = Thread.create('codec');

await codec.run(() => {
  const pixels = decodeFrame(bytes);   // on the 'codec' thread
  const summary = analyze(pixels);

  Thread.main.run(() => {
    applyToNativeView(summary);        // on the main thread
  });
});
```

The important part is what *isn't* happening: there's no second runtime and
nothing is serialized. The callback is a plain closure that keeps every binding
it captured — same variables, same objects, same identity. Only the OS thread
executing the runtime changes.

```js
let progress = 0;
await codec.run(() => { progress = 50; }); // same variable, no message passing
console.log(progress);                     // 50
```

That works because every entry into a worker's runtime — its event loop, timers,
native module callbacks, the debugger, and `Thread.run` — now goes through a
per-worker lock, so exactly one thread is ever inside the runtime. It is **thread
affinity, not parallelism**: a `run()` body is atomic, and a slow one blocks the
worker (or janks the UI, if it's on `Thread.main`).

Promises settle back on the worker's *own* thread, so `await` always returns you
where you started and thread changes only ever happen inside a `run()` callback —
the single-threaded mental model survives.

It's off by default and gated per worker behind
`enableMultiThreadingExperimental()`. The [Thread hopping
guide](/docs/guides/threads) covers the rules before you ship it — and when a
plain `Worker` or a [`UIWorker`](/docs/guides/ui-worker) is the better tool.

## Messaging, cloning, and nesting

Data crosses the boundary via **structured clone** — objects, arrays, `Date`, typed
arrays, `ArrayBuffer`, and cycles all survive (a few types don't yet; see below), all
covered in the [messaging guide](/docs/guides/messaging). **Nested workers** work — a
worker can spawn its own children and relay their results — and RN **device events** are
forwarded into workers ([native events guide](/docs/guides/native-events)), so a worker
can listen for the same app-level events the main thread sees — the
[sensor-stream tutorial](/docs/tutorials/sensor-stream) leans on exactly that.

## Debugging

Workers aren't a black box:

- **`console.*` inside a worker is forwarded to your main logs**, tagged per worker
  (`[RNWorker <id>]`), so you see worker output where you already look.
- **`inspectable: true`** attaches a Hermes debugger to a worker (background workers
  are inspectable by default). Set breakpoints and step through worker code like any
  other runtime.
- **`maxHeapMb`** lets you cap (or raise) a worker's heap when you know it's doing
  something memory-heavy.

## Tested against a lot of React Native and Expo

react-native-workers is New-Architecture-native: bridgeless, Hermes, JSI throughout.
It supports **React Native 0.81.4+** on **iOS and Android**.

Depending on private React Native and Expo internals is a fact of life for a library
like this — so there's a compatibility matrix that scaffolds a fresh app against each
version and compiles the native code, on every relevant release:

- **React Native** 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, `latest`, and the `next`
  release candidate.
- **Expo SDK** 54, 55, 56, 57, and `latest`.

On top of that, the example app carries an on-device conformance suite and a
benchmark screen — both of which you can run yourself from the
[example app](https://github.com/ammarahm-ed/react-native-workers/tree/main/example):

<Showcase>
  <DeviceFrame
    width={262}
    src="/img/screens/tests.webp"
    alt="The example app's test suite screen showing 76 of 76 tests passed, covering workers, native modules, the RPC bridge and the shared primitives"
    caption={<>The in-app suite on an iPhone 17 Pro simulator: 76/76, covering nested workers, native modules, device events, the RPC bridge and every shared primitive.</>}
  />
  <DeviceFrame
    width={262}
    src="/img/screens/benchmarks.webp"
    alt="Benchmark results including 0.016ms per message round-trip, 143MB/s typed-array transfer, SharedValue writes at 0.091 microseconds and setIn being 2x cheaper than messaging"
    caption={<>The benchmark screen, measured on the same device: message round-trips, bulk transfer, and where each shared primitive actually wins.</>}
  />
</Showcase>

## What "alpha" means

The core is implemented and tested on both platforms, and the API is close to what I
want it to be — but this is a `1.0.0-alpha`, so:

- **Release loading for *file* workers is still being finished.** File workers load
  fully in **development** (Metro serves each worker bundle); loading them from a
  **release** build needs a native asset reader that's in progress. **Inline workers
  work everywhere**, dev and release, so you're never blocked — see
  [Bundling for release](/docs/guides/bundling).
- **Structured clone** doesn't yet copy `Map`, `Set`, `RegExp`, `Error`, or `BigInt`.
- **`Thread` is experimental**, off unless you call
  `enableMultiThreadingExperimental()`, and its shape may change. There is no
  synchronous `runSync` on purpose — see [the rules](/docs/guides/threads#the-rules).
- The API may still shift before `1.0.0`.

If you hit an edge, that's exactly the feedback this release is for.

## Where it's going

A couple of things on the near horizon:

- **Finishing release file-worker loading** — the native asset reader on both
  platforms, so file workers ship in release builds too.
- **Transferables** — a `postMessage(msg, [transfer])` transfer-list on top of the
  shared-memory primitives that already exist, for true zero-copy handoff.

## Try it

```bash
npm install @ammarahmed/react-native-workers@alpha
```

Then the [Installation guide](/docs/installation) and the
[Quick start](/docs/quick-start) get you running your first worker in a few minutes,
and the [guides](/docs/intro) go deep on native modules, UIWorker, and shared state.
Every feature above has a runnable example — browse them all under
[Examples](/docs/examples), or clone the
[example app](https://github.com/ammarahm-ed/react-native-workers/tree/main/example) and
run it.

If you're building something that would genuinely benefit from real threads — a heavy
importer, an on-device pipeline, a game loop, an editor that shouldn't stutter — this
is a great time to try it and tell me what breaks or what's missing.

- ⭐ [Star it on GitHub](https://github.com/ammarahm-ed/react-native-workers)
- 🐛 [Open an issue](https://github.com/ammarahm-ed/react-native-workers/issues)
- 📚 [Read the docs](/docs/intro)

More threads, less jank. Let's see what you build.
