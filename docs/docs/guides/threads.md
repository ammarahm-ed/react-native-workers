---
sidebar_position: 8
title: Thread hopping (experimental)
---

# `Thread` — run a worker's JS on another thread

:::danger[Experimental]
This API is off by default and must be enabled per worker with
`enableMultiThreadingExperimental()`. The shape may change. Read
[The rules](#the-rules) before shipping it.
:::

A worker owns a JavaScript runtime pinned to one thread. `Thread` lets that
*same* runtime temporarily execute on a **different** thread — the main/UI
thread, or a background thread you create.

```js
enableMultiThreadingExperimental();

const encoder = Thread.create('audio-encode');

const frames = await encoder.run(() => {
  // Runs on the 'audio-encode' thread, with this worker's runtime.
  return encodePcm(buffer);
});
```

## What this is not

It is **not** a second runtime, and nothing is serialized. The callback is a
plain closure that keeps every binding it captured:

```js
let progress = 0;
const cache = new Map();

await encoder.run(() => {
  progress = 50;          // same variable
  cache.set('k', 'v');    // same Map, same object identity
});

console.log(progress);         // 50
console.log(cache.get('k'));   // 'v'
```

What changes is only **which OS thread is executing the runtime** while the
callback runs. Compare that with [`postMessage`](./messaging), which copies data
between two separate runtimes.

## Background, then UI

The shape this exists for: do heavy work off the UI thread, then apply the result
on it.

```js
enableMultiThreadingExperimental();

const codec = Thread.create('codec');

await codec.run(() => {
  const pixels = decodeFrame(bytes);      // on 'codec'
  const summary = analyze(pixels);        // still on 'codec'

  Thread.main.run(() => {
    applyToNativeView(summary);           // on the main thread
  });
});
```

The inner `Thread.main.run()` is asynchronous — it queues, and runs once the
outer callback releases the runtime. That is what makes nesting deadlock-free.

## `await` always brings you home

A `run()` promise settles on the **worker's own thread**, never on the target's:

```js
console.log(Thread.current);       // '' — the worker's own thread
await encoder.run(() => {
  console.log(Thread.current);     // 'audio-encode'
});
console.log(Thread.current);       // '' — back home
```

Thread changes only ever happen *inside* a `run()` callback. Code after an
`await` continues where it started, so the worker's single-threaded mental model
survives.

## API

| | |
| --- | --- |
| `enableMultiThreadingExperimental()` | Opt in. Every `Thread` entry point throws until this is called. Per worker. |
| `Thread.create(name?)` | A new serial background thread. |
| `Thread.main` | The platform main/UI thread. Throws where `UIWorker` is also unavailable. |
| `Thread.current` | Name of the thread currently executing; `''` on the worker's own thread. |
| `thread.run(fn)` | Runs `fn` on that thread; resolves with its return value (rejects if it throws). |
| `thread.dispose()` | Stops the thread. In-flight calls still settle; queued ones are dropped. |
| `thread.disposed` | Whether `dispose()` has been called. |

TypeScript users can pull in the types — they describe worker globals, so declare
what you use:

```ts
import type { ThreadApi } from '@ammarahmed/react-native-workers';

declare const Thread: ThreadApi;
declare function enableMultiThreadingExperimental(): boolean;
```

## The rules

**One thread is inside the runtime at a time.** Every entry into a worker's
runtime — its event loop, timers, native module callbacks, the debugger, and
`Thread.run` — takes a per-worker lock. That is what makes this safe; it is not
parallel JS execution.

**A `run()` body is atomic.** Nothing else enters the runtime while it runs, so a
read-modify-write inside one body cannot interleave with another. Across bodies
it can, exactly like any two async tasks.

**Long callbacks block.** While a callback runs on thread A, the worker's own
thread waits to re-enter. A slow `Thread.main.run()` janks the UI, and a slow
background callback stalls the worker. Keep bodies short.

**Calls on one thread are serial.** FIFO, one at a time. Use separate threads for
genuinely independent work — but note they still serialize against each other on
the runtime lock, so this buys you *thread affinity*, not throughput.

**Don't do blocking waits.** There is no synchronous `runSync`, on purpose: a
callback that blocks waiting for the thread that is waiting for it deadlocks.
Async hops compose safely; synchronous ones do not.

## When to reach for something else

`Thread` is for work that must happen **on a specific thread** while sharing this
worker's live JS state. If you just want work off the UI thread, a plain
[`Worker`](./creating-workers) is simpler and gives you real parallelism. If you
want shared state across runtimes without hopping, use
[`SharedValue` / `SharedBuffer` / `SharedStore`](../shared-data/overview).

For UI-thread work specifically, a [`UIWorker`](./ui-worker) runs an entire
runtime on the main thread with no per-call hop at all — better when *most* of
the code is UI-affine. `Thread.main` is better when most of it is not.
