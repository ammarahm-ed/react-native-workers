---
sidebar_position: 2
title: Messaging & structured clone
---

# Messaging & structured clone

Workers communicate with `postMessage`. This page explains what can cross the
boundary, how copying works, and when to reach for something faster.

## The basics

```js
// host
worker.postMessage({ hello: 'world', nums: [1, 2, 3] });
worker.onmessage = (e) => console.log(e.data);

// worker
self.onmessage = (e) => {
  console.log(e.data.hello); // 'world'
  self.postMessage('got it');
};
```

Each message is delivered as a `MessageEvent` whose `.data` is a **copy** of what
you sent, decoded into the receiving runtime.

## What can be sent (structured clone)

Values are serialized with a structured-clone algorithm, so you can send:

- primitives — `number`, `string`, `boolean`, `null`, `undefined`;
- plain objects and arrays, **including cycles and shared references**
  (`a.self = a` works; two properties pointing at the same object stay shared);
- `Date`;
- typed arrays (`Uint8Array`, `Float64Array`, …) and `ArrayBuffer`.

```js
const a = { name: 'node' };
a.self = a;                       // cycle — fine
worker.postMessage({ a, again: a }); // shared ref preserved on the other side
```

You **cannot** send functions, class instances (they arrive as plain data), or
things that hold native handles. Sending an unsupported value throws a
`DataCloneError`.

:::note[Not yet cloned]
`Map`, `Set`, `RegExp`, `Error`, and `BigInt` are not part of the v1 clone subset.
:::

## Binary data & transfer

Binary payloads (`ArrayBuffer` / typed arrays) are the common heavy case — image
bytes, database blobs. They are copied at most once and decoded zero-copy on the
receiving side, so throughput is high (measured ~1.5 GB/s on Android).

You can pass a **transfer list** as the second argument to hint that a buffer is
being handed off:

```js
const bytes = new Uint8Array(8 * 1024 * 1024);
worker.postMessage(bytes, [bytes.buffer]);
```

:::info
Hermes does not support true `ArrayBuffer` detach, so the transfer list is a
throughput hint rather than a zero-copy ownership transfer. The buffer remains
usable on the sending side. See [Performance](../performance).
:::

## Message ordering & buffering

- Messages are delivered **in order** (FIFO).
- Messages sent before the receiver attaches a handler are **buffered** and
  delivered once `onmessage` (or `addEventListener('message')`) is set — you won't
  miss the first message.

## When copying is too much

`postMessage` copies the payload every time. If you're sending the **same** or
**incrementally-changing** data repeatedly, copying is wasteful. Use shared data
instead:

| Situation | Use |
| --- | --- |
| Structured state read/updated by both sides | [`SharedStore`](../shared-data/shared-store) |
| One hot number/flag updated every frame | [`SharedValue`](../shared-data/shared-value) |
| A large numeric array crunched in a loop | [`SharedBuffer`](../shared-data/shared-buffer) |
| A request that returns a result | [JSModule bridge](../rpc/jsmodule-bridge) / [`defineModule`](../rpc/define-module) |

For example, a worker that repeatedly reads a large config object should read it
from a `SharedStore` once, not receive it in every message.

## Error handling

An uncaught error in a worker does **not** crash it — it's reported to the host and
the worker keeps running:

```js
worker.onerror = (e) => {
  console.warn(e.message, 'at', e.filename + ':' + e.lineno);
};
```

Inside the worker, prefer normal `try/catch` and reply with an error shape when you
want the host to react:

```js
self.onmessage = (e) => {
  try {
    self.postMessage({ ok: true, value: doWork(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err.message) });
  }
};
```
