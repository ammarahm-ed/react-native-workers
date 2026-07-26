---
sidebar_position: 1
title: Creating workers
---

# Creating workers

A `Worker` is a JavaScript runtime running on its own OS thread. This page covers
the ways to create one, its lifecycle, and how to clean it up.

## File workers

This is how you'll normally create a worker: keep its code in its own file.
Install the [Babel plugin](./bundling), then reference the file by relative path.

```js title="src/workers/resize.js"
self.onmessage = (e) => {
  const resized = resize(e.data.bytes, e.data.width);
  self.postMessage(resized, [resized.buffer]); // transfer list — a throughput hint
};
```

```js title="src/gallery.js"
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker('./workers/resize');
```

The path is relative to the file that calls `new Worker(...)`. The plugin compiles
`./workers/resize` into its own bundle and rewrites the call so the runtime can
load it. See [Bundling](./bundling) for dev vs release.

## Inline workers (small snippets)

For a tiny or dynamically-generated worker you can skip the file and pass the
source as a string — no Babel plugin needed:

```js
const worker = new Worker({
  inline: `self.onmessage = (e) => self.postMessage(e.data.toUpperCase());`,
});
```

Reach for this only for small code; anything real belongs in a file.

Either way the worker's code is fully self-contained: it does **not** share scope
with your app. It has its own globals, its own module instances, its own
everything — the worker environment (`self`, `postMessage`, timers, `SharedStore`,
…) but not your app's variables.

## Options

```ts
new Worker(source, {
  name?: string,          // a label (useful in logs)
  nativeModules?: boolean,// opt into platform (Java/ObjC) TurboModules (default false)
});
```

- **`name`** — a human-readable label.
- **`nativeModules`** — build the per-worker platform TurboModule manager so the
  worker can call Java/ObjC modules. Off by default (it costs memory + teardown);
  C++ modules and nested workers work without it. See
  [Native modules](./native-modules).

`UIWorker` takes two more — `independent` and `inspectable` — described in the
[UIWorker guide](./ui-worker). A `maxHeapMb` option also exists on the type, but
it is **not applied yet**: every worker currently gets Hermes' 256 MB default.

## Sending and receiving

```js
// Host → worker
worker.postMessage({ type: 'start', payload: 123 });

// Worker → host
worker.onmessage = (e) => console.log(e.data);
worker.addEventListener('message', (e) => console.log(e.data)); // also works

// Errors thrown in the worker surface here (the worker keeps running):
worker.onerror = (e) => console.warn('worker error:', e.message);
```

Messages sent **before** a handler is attached are buffered and delivered once you
set `onmessage` (matching the Web spec's port queue), so you never miss the first
reply.

## Terminating

A worker holds a thread and a runtime. When you're done, free them:

```js
worker.terminate();
```

After `terminate()`:

- queued and future messages are dropped;
- the worker's thread finishes its current task, tears down native resources
  (e.g. any TurboModule manager), then the runtime is destroyed;
- the worker object is inert — further `postMessage` calls are no-ops.

:::tip[Reuse workers]
Creating a worker spins up a whole runtime (a few ms). For repeated work, **keep a
worker alive** and send it many messages rather than creating one per task. Pool a
small number of workers for parallelism.
:::

## Nested workers

A worker can create its own workers — the `Worker` class is available inside the
worker environment too:

```js
const parent = new Worker({
  inline: `
    self.onmessage = (e) => {
      const child = new Worker({ inline: "self.onmessage = ev => self.postMessage(ev.data * 2);" });
      child.onmessage = (ce) => self.postMessage(ce.data);
      child.postMessage(e.data);
    };
  `,
});
parent.onmessage = (e) => console.log(e.data); // 84
parent.postMessage(42);
```

## The worker environment

Inside a worker you have:

- `self`, `postMessage`, `onmessage`, `close()`, `addEventListener`,
  `MessageEvent` / `ErrorEvent`;
- `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` /
  `setImmediate` / `clearImmediate` / `queueMicrotask`, Promises, `async`/`await`;
- `structuredClone`, `console` (forwarded to the host logs), `location`,
  `importScripts()`;
- `Worker` (nested), `SharedStore`, `SharedValue`, `SharedBuffer`;
- `JSModule` / `parent` / `defineModule` (the [RPC bridge](../rpc/jsmodule-bridge));
- `NativeEventEmitter` and the native-module accessor (see
  [Native modules](./native-modules));
- `Thread` / `enableMultiThreadingExperimental()` — opt-in and experimental, for
  running this worker's own runtime on another thread ([Thread hopping](./threads)).

There is **no DOM** and no React — a worker is a headless compute environment.
