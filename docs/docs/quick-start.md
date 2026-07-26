---
sidebar_position: 3
title: Quick start
---

import DeviceFrame from '@site/src/components/DeviceFrame';

# Quick start

This page builds up from the simplest possible worker to something useful. Every
snippet below is complete and runnable.

## 1. A worker in a file

A worker is a self-contained piece of JavaScript that runs on another thread. You
normally write it in **its own file**:

```js title="src/workers/square.js"
// This code runs on ANOTHER thread, in its own JS runtime.
self.onmessage = (e) => {
  const result = e.data * e.data;   // pretend this is expensive
  self.postMessage(result);
};
```

Load it by relative path and talk to it from your app:

```js title="src/screen.js"
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker('./workers/square'); // compiled into its own bundle

worker.onmessage = (e) => {
  console.log('got', e.data); // got 1764
};

worker.postMessage(42);
```

- `self.onmessage` (inside the worker) receives messages from the host.
- `self.postMessage(...)` sends a message back.
- `worker.postMessage(...)` / `worker.onmessage` are the host's side.

The path is relative to the file that calls `new Worker(...)`, and loading it needs
the one-line [Babel plugin](./installation#3-add-the-babel-plugin) — the plugin
compiles each worker file into its own bundle.

:::info[Alpha status]
File workers load fully in **development** (Metro serves each worker bundle). Loading
them from a **release** build needs a native asset reader that's still being finished
— see [Bundling for release](./guides/bundling). **Inline workers** (next section)
already work everywhere, dev and release.
:::

Data is **structured-cloned** across the thread boundary — objects, arrays,
`Date`, typed arrays, `ArrayBuffer`, and cycles all work.

## 2. Inline snippets (for small code)

For a tiny or dynamically-generated worker, you can skip the file and pass the
source as a string — no Babel plugin needed. It's handy for one-offs, like a
helper that turns a single request/response into a `Promise`:

```js
function runOnce(code, input) {
  return new Promise((resolve) => {
    const w = new Worker({ inline: code });
    w.onmessage = (e) => {
      resolve(e.data);
      w.terminate(); // free the thread when done
    };
    w.postMessage(input);
  });
}

const primes = await runOnce(
  `self.onmessage = (e) => {
     const n = e.data, out = [];
     for (let i = 2; i < n; i++) {
       let p = true;
       for (let j = 2; j * j <= i; j++) if (i % j === 0) { p = false; break; }
       if (p) out.push(i);
     }
     self.postMessage(out);
   }`,
  100000, // heavy — but it won't block your UI
);
```

Inline code is for small snippets; anything real belongs in a file. For a typed,
function-style API instead of hand-rolling request/response, see
[`defineModule`](./rpc/define-module).

## 3. Share state instead of copying it

Passing big data through `postMessage` copies it every time. For shared state,
use a [`SharedStore`](./shared-data/shared-store) — one store, visible to the host
and every worker:

```js
import { SharedStore } from '@ammarahmed/react-native-workers';

// Host
const store = new SharedStore('session');
store.set('user', { id: 1, name: 'Ada' });

// Worker (inline)
const worker = new Worker({
  inline: `
    const store = new SharedStore('session');
    self.onmessage = () => {
      const user = store.get('user'); // same data, no message needed
      self.postMessage('hello ' + user.name);
    };
  `,
});
```

For hot numbers use [`SharedValue`](./shared-data/shared-value); for bulk arrays
use [`SharedBuffer`](./shared-data/shared-buffer).

## What it looks like in practice

Here is that idea at full size: the [image-filters example](./tutorials/image-filters)
keeps a bitmap in shared memory and filters it in a worker, then reports the worst
UI frame gap the run caused — one frame, for work that takes a quarter of a second.

<DeviceFrame
  width={300}
  src="/img/screens/imagefx.webp"
  alt="The image-filters screen showing a source and a blurred image side by side, with a line reading 'blur in the worker — filter 254ms, encode 22ms' and 'worst UI frame gap during that run: 17ms'"
  caption={<>Run the same blur on the JS thread with the red button and the frame gap becomes the whole duration. Same pixels, same work, wrong thread.</>}
/>

## Where to go next

- **[Creating workers](./guides/creating-workers)** — lifecycle, inline vs file,
  terminating, options.
- **[Messaging](./guides/messaging)** — what can cross the boundary and how.
- **[Shared data overview](./shared-data/overview)** — choose the right primitive.
- **[defineModule](./rpc/define-module)** — call worker functions like local
  async functions, fully typed.
