<div align="center">

<img src="docs/static/img/workers.png" alt="" width="120" height="120" />

# React Native Workers

**Real threads for React Native.** Web Worker–style API, backed by a separate
Hermes runtime on its own thread — with structured-clone messaging, timers,
shared memory, and full native-module access.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-iOS%20%7C%20Android-lightgrey.svg)](#)
[![React Native](https://img.shields.io/badge/React%20Native-0.81.4%2B-61dafb.svg)](https://reactnative.dev)
[![New Architecture](https://img.shields.io/badge/New%20Architecture-Hermes-brightgreen.svg)](https://reactnative.dev/architecture/landing-page)

[Documentation](https://ammarahm-ed.github.io/react-native-workers/) ·
[Quick start](https://ammarahm-ed.github.io/react-native-workers/docs/quick-start) ·
[API reference](https://ammarahm-ed.github.io/react-native-workers/docs/api-reference) ·
[Examples](https://ammarahm-ed.github.io/react-native-workers/docs/examples)

</div>

---

React Native runs all your JavaScript on a single JS thread, and drives UI
updates from it. A long parse, a big image filter, or a tight simulation loop
blocks that thread — so it can't dispatch updates and your UI stalls.

This library gives you a real one:

```js
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker({
  inline: `self.onmessage = (e) => self.postMessage({ doubled: e.data * 2 });`,
});

worker.onmessage = (e) => console.log(e.data); // { doubled: 42 }
worker.postMessage(21);
```

It's a headless React Native: no UI, but the same JavaScript engine, the same
timers and Promises, and the same native modules you already use.

## Why it's different

|  | |
| --- | --- |
| **A real thread** | Its own Hermes runtime with its own heap and event loop, not a time-slice of yours. |
| **Native modules work** | TurboModules, legacy modules and Nitro modules all resolve inside a worker — `react-native-mmkv`, `react-native-blob-util` and friends work unmodified. |
| **Shared memory, not just messages** | A ladder from `postMessage` to lock-free shared cells and raw shared `ArrayBuffer`s — pick the cost you want to pay. |
| **Typed two-way RPC** | Call across the boundary like a local `async` function, in both directions, with one shared type. |
| **Small bundles** | Worker bundles ship ~150 KB instead of ~1.4 MB, because the UI half of React Native never enters the graph. |
| **Debuggable** | Every worker is its own DevTools target — breakpoints, stepping, and `console.log` forwarded to the host with a `[Worker:name]` tag. |

## Install

```sh
npm install @ammarahmed/react-native-workers
```

Requires the **New Architecture** with **Hermes** (RN 0.81.4+, developed against
0.86). Native code is autolinked; run `pod install` on iOS.

Then wrap your Metro config — this is what keeps worker bundles small:

```js title="metro.config.js"
const { getDefaultConfig } = require('@react-native/metro-config');
const { withWorkers } = require('@ammarahmed/react-native-workers/metro');

module.exports = withWorkers(getDefaultConfig(__dirname));
```

Full setup — including the Babel plugin for file-based workers and the one-time
Android native-module registration — is in the
[installation guide](https://ammarahm-ed.github.io/react-native-workers/docs/installation).

## A tour

<details>
<summary><b>Workers from files</b> — auto-bundled, one Metro graph each</summary>

Add the Babel plugin to `babel.config.js`, then reference a file relatively:

```js
const worker = new Worker('./workers/heavy-task');
```

Each entry is compiled into its own bundle — fetched from Metro in development,
loaded as a Hermes bytecode asset in release. See the
[bundling guide](https://ammarahm-ed.github.io/react-native-workers/docs/guides/bundling)
and [`design-docs/release-bundling.md`](design-docs/release-bundling.md).

</details>

<details>
<summary><b>Native modules inside a worker</b></summary>

C++ (Cxx) modules and nested workers work by default. Platform (Java/ObjC)
modules are opt-in per worker, because building the per-worker TurboModule
manager costs memory:

```js
const worker = new Worker('./workers/task', { nativeModules: true });
```

- **iOS** — a per-worker `RCTTurboModuleManager` resolves any registered ObjC
  module through the global registry. No app changes.
- **Android** — register your packages once, since there is no global registry:

  ```kotlin
  reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener {
    override fun onReactContextInitialized(context: ReactContext) {
      if (context is ReactApplicationContext) {
        WorkerTurboModules.initialize(context, PackageList(this@MainApplication).packages)
      }
    }
  })
  ```

RN's core modules (`SourceCode`, `PlatformConstants`, `DeviceInfo`, …) are added
automatically. UI-affine modules (UIManager and friends) are denylisted.
[Details](https://ammarahm-ed.github.io/react-native-workers/docs/guides/native-modules).

</details>

<details>
<summary><b>Native events</b> — <code>NativeEventEmitter</code> in a worker</summary>

```js
// inside a worker
const emitter = new NativeEventEmitter(someNativeModule);
const sub = emitter.addListener('SomeEvent', (payload) => {
  // fires on the worker thread
});
```

C++ module events are delivered straight to the worker via its own CallInvoker.
Events from Java/ObjC modules — and anything sent through the app's
`DeviceEventEmitter` — are emitted on the host and forwarded to workers that
registered a listener.
[Details](https://ammarahm-ed.github.io/react-native-workers/docs/guides/native-events).

</details>

<details>
<summary><b>Shared state</b> — <code>SharedStore</code>, <code>SharedValue</code>, <code>SharedBuffer</code></summary>

`SharedStore` is a C++-backed store shared by the host and every worker, with
synchronized reads/writes and change watchers:

```js
const store = new SharedStore('session');
store.set('user', { id: 1, name: 'Ada' });
const off = store.subscribe('user', (key, value) => { /* any runtime wrote */ });
```

Unlike `postMessage`, a stored value is an addressable tree — read and update
*parts* of it, and watch just a subtree:

```js
store.setIn('doc', ['user', 'age'], 31);           // encodes only the new leaf
store.subscribeIn('doc', ['user'], (path, value) => { /* ['age'], 31 */ });
```

For hot paths there are two leaner primitives:

```ts
// A single synchronous cell — lock-free for numbers (~17M writes/sec).
const progress = new SharedValue('anim:progress', 0);
progress.value = 0.42;

// Raw shared memory — same bytes in every runtime, zero host calls per element.
const buf = new SharedBuffer('sim', 50_000 * Float64Array.BYTES_PER_ELEMENT);
const view = new Float64Array(buf.arrayBuffer);
```

`SharedValue` is ~2× faster than `SharedStore` for a single value; `SharedBuffer`
is ~4× faster for bulk numeric work. The full ladder, with benchmarks, is in
[`design-docs/shared-data-primitives.md`](design-docs/shared-data-primitives.md).

</details>

<details>
<summary><b>Typed RPC</b> — the <code>JSModule</code> bridge and <code>defineModule</code></summary>

Call across the worker boundary as if it were a local `async` function — a
two-way JS→JS RPC:

```js
// worker (JSModule is a global in every worker)
new JSModule('calc', {
  add(a, b) { return a + b; },
  async fetchUser(id) { return await load(id); },
});
```

```ts
// host — fully typed
const calc = worker.module<Calc>('calc');
await worker.ready('calc');
const sum = await calc.add(2, 3); // 5
```

The worker can call back into the host, modules emit events, and large params
are best passed by `SharedStore` reference rather than cloned per call.

`defineModule` folds the bridge and reactive state into one contract both sides
implement halves of:

```ts
export const calc = defineModule<{
  worker: { add(a: number, b: number): number };
  host:   { getConfig(): Config };
  events: { progress: { percent: number } };
  state:  { status: 'idle' | 'busy' };
}>('calc');
```

Design and wire protocol: [`design-docs/jsmodule-bridge.md`](design-docs/jsmodule-bridge.md),
[`design-docs/jsmodule-defineModule.md`](design-docs/jsmodule-defineModule.md).

</details>

<details>
<summary><b><code>UIWorker</code></b> — a worker on the UI thread</summary>

A non-spec worker whose runtime lives on the platform main thread, so it can call
UI-affine native methods with no thread hop. Same API as `Worker`; supported on
both platforms. Use sparingly — work here competes with rendering.

```js
const w = new UIWorker({ inline: `self.onmessage = (e) => { /* UI-thread JS */ };` });
```

</details>

<details>
<summary><b>From native code</b></summary>

Workers can be created and driven from C++ on any thread via
[`cpp/api/NativeWorkers.h`](cpp/api/NativeWorkers.h) (a JSON message bridge) —
useful for background JS triggered by native events.

</details>

## Bundle size

Each worker is its own Metro graph, so `import … from 'react-native'` pulls the
whole framework — renderer, components, Animated, virtualized-lists — into every
worker that reaches it. Third-party native modules import that barrel themselves,
so careful worker code alone cannot avoid it.

`withWorkers()` resolves `react-native` to a worker-sized shim **inside worker
graphs only**. Measured on the example app (Hermes bytecode, minified):

| worker | without | with |
| --- | --- | --- |
| `react-native-gzip` (legacy module) | 1.39 MB | **149 KB** |
| `react-native-mmkv` (Nitro) | 1.42 MB | **302 KB** |
| `react-native-blob-util` (TurboModule) | 1.50 MB | **264 KB** |
| a worker importing nothing | 17.8 KB | 17.8 KB |

Exports a worker cannot use (`View`, `StyleSheet`, `Animated`, hooks…) throw on
access with a message naming the export, instead of being silently `undefined`.

## What's supported

Structured clone (objects, arrays, cycles, typed arrays, `ArrayBuffer`, `Date`),
`self` / `postMessage` / `onmessage` / `close` / `addEventListener`, timers,
Promises, `structuredClone`, error propagation to `onerror`, `terminate`, worker
isolation, and `NativeEventEmitter`.

Also inside a worker: **Expo Modules** via `requireNativeModule(...)` on both
platforms, and the experimental
[`Thread`](https://ammarahm-ed.github.io/react-native-workers/docs/guides/threads)
API for running a worker's own runtime on another thread.

`Map` / `Set` / `RegExp` / `Error` / `BigInt` are not in the clone subset yet.
Full transfer-list detach and `SharedArrayBuffer` are out of scope (Hermes
limitations) — [`SharedBuffer`](#a-tour) covers the shared-memory use case
instead.

## Example app

The [`example/`](example) app is a gallery of working screens — search service,
image filters, downloads, sensors, parallel parsing, notes — plus a conformance
suite covering the API surface. Step-by-step build-ups for each screen are in the
[tutorials](https://ammarahm-ed.github.io/react-native-workers/docs/category/tutorials).

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)

## License

MIT © Ammar Ahmed

---

<div align="center">
Made with <a href="https://github.com/callstack/react-native-builder-bob">create-react-native-library</a>
</div>
