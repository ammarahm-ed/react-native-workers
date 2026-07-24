---
sidebar_position: 1
title: Introduction
slug: /intro
---

# react-native-workers

**Web Worker–style multithreading for React Native.** Each worker runs your
JavaScript in a **separate Hermes runtime on its own thread**, with
`postMessage`/`onmessage` semantics, structured-clone messaging, timers, and
access to native modules — a headless React Native with no UI.

Write a worker in its own file:

```js title="workers/double.js"
self.onmessage = (e) => self.postMessage({ doubled: e.data * 2 });
```

Load it by path and talk to it:

```js title="App.js"
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker('./workers/double');

worker.onmessage = (e) => console.log(e.data); // { doubled: 42 }
worker.postMessage(21);
```

File workers need a one-line [Babel plugin](./installation#3-add-the-babel-plugin);
for a throwaway snippet you can also pass `{ inline: '…code…' }` instead of a path.

## Why

React Native runs all your JavaScript on a single **JS thread**, dispatching UI
updates from it to the separate UI thread. Heavy work — parsing, crypto,
image/data processing, database work, physics — blocks that JS thread, so it
can't drive updates and the UI janks. `react-native-workers` moves that work to
**real OS threads running real JavaScript**, so the JS thread stays free.

Unlike a plain thread pool, a worker is a full JS environment: timers, promises,
`fetch` where available, and — uniquely — **native modules**. And unlike
`postMessage`-only libraries, it ships a whole spectrum of fast data-sharing
primitives, from async messaging down to raw shared memory.

## What you get

- **Real Web Worker API** — `new Worker(...)`, `postMessage`/`onmessage`,
  `terminate`, `MessageEvent`, structured clone, timers, error propagation.
- **Native modules inside workers** — call C++ (Cxx) modules, platform
  (Java/ObjC) TurboModules and legacy modules from a worker; subscribe to
  `NativeEventEmitter` events.
- **Nested workers** — a worker can spawn its own workers.
- **A spectrum of shared data**:
  - [`SharedStore`](./shared-data/shared-store) — synchronized, watchable,
    granularly-patchable shared state (lazy reads, `setIn`, `subscribeIn`).
  - [`SharedValue`](./shared-data/shared-value) — a single synchronous cell,
    lock-free for numbers (~8M writes/sec).
  - [`SharedBuffer`](./shared-data/shared-buffer) — true zero-copy shared memory
    across runtimes for bulk numeric work.
- **Typed RPC** — the [JSModule bridge](./rpc/jsmodule-bridge) and
  [`defineModule`](./rpc/define-module) let host and worker call each other's
  functions like local `async` functions, fully typed.
- **`UIWorker`** — a worker whose JS runs on the platform UI/main thread. Its
  runtime is [shared and persistent](./guides/ui-worker#shared-persistent-runtimes)
  by default, so it survives navigation.
- **Debuggable** — every background worker is its own
  [DevTools target](./guides/debugging) (breakpoints, stepping, sources), and
  `console` output is forwarded to the host, tagged with the worker's name.
- **Fast, small bundles** — release worker bundles are precompiled to Hermes
  bytecode and ship [~150 KB each](./guides/bundling), not the ~1.4 MB of the
  full framework.

## Requirements

- React Native with the **New Architecture** (bridgeless) and **Hermes**.
- RN 0.76+ (developed against **0.85**).
- iOS and Android.

## Where to next

- [Installation](./installation) — add the package and (on Android) register
  native modules.
- [Quick start](./quick-start) — your first worker in five minutes.
- [Creating workers](./guides/creating-workers) — lifecycle, options, nesting.
- [Shared data](./shared-data/overview) — pick the right primitive for your
  workload.
