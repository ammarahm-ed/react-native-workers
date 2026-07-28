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
- typed arrays (`Uint8Array`, `Float64Array`, …) and `ArrayBuffer`;
- `Map`, `Set`, `RegExp`, `Error` (name, message, stack), and `BigInt`.

```js
const a = { name: 'node' };
a.self = a;                       // cycle — fine
worker.postMessage({ a, again: a }); // shared ref preserved on the other side
worker.postMessage(new Map([['k', new Set([1, 2])]])); // fine
```

You **cannot** send functions, class instances (they arrive as plain data), or
things that hold native handles. Sending an unsupported value throws a
`DataCloneError`.

## Binary data & transfer

Binary payloads (`ArrayBuffer` / typed arrays) are the common heavy case — image
bytes, database blobs. They are copied at most once and decoded zero-copy on the
receiving side, so throughput is high (measured ~5 GB/s on Android).

Pass a **transfer list** as the second argument to hand a buffer off instead of
copying it:

```js
const bytes = new Uint8Array(8 * 1024 * 1024);
worker.postMessage(bytes, [bytes.buffer]);
// `bytes.buffer` now belongs to the receiver — see the caveat below
```

### Getting a genuinely zero-copy buffer

Whether the handoff copies depends on where the buffer came from, and this is a
Hermes constraint rather than a choice:

| Buffer | On transfer |
| --- | --- |
| `createTransferableBuffer(n)` | **Zero-copy**, every hop, both directions |
| `new ArrayBuffer(n)` | Copied once on the first hop, then zero-copy |

`createTransferableBuffer(n)` is a global in every runtime (host and worker) and
returns an ordinary `ArrayBuffer` — the only difference is that its backing store
is one Hermes will let me move. Hermes only surrenders the store of an *external*
buffer, so a plain `new ArrayBuffer` has to be copied once before it becomes
transferable.

```js
const buf = createTransferableBuffer(8 * 1024 * 1024);
new Uint8Array(buf).set(pixels);
worker.postMessage(buf, [buf]);   // no copy at all
```

### After you transfer

:::warning[Transfer is enforced by this library, not by the engine]
Hermes has no `ArrayBuffer` detach, so a transferred buffer is not *neutered* the
way it would be in a browser. What is always enforced:

- the message path refuses to clone or re-transfer a buffer you already gave away;
- `buffer.detached` reports `true`.

What is **not** enforced by default: reading or writing the bytes still works on
the sending side, and racing the receiver that way is a data race.

Call `enableTransferGuard()` once, early, to make stale access throw instead:

```js
import { enableTransferGuard } from '@ammarahmed/react-native-workers';
enableTransferGuard();
```

It is opt-in because it patches global constructors (`Uint8Array`, `DataView`,
`%TypedArray%.prototype`), which has real costs — `value.constructor === Uint8Array`
stops matching, every view construction pays a `Reflect.construct`, and it can
collide with other libraries that patch the same globals. Indexed access on a view
you already created is still not interceptable even with the guard on.

See [Hacks & compatibility seams](/docs/compat-seams#simulated-arraybuffer-transfer)
for why this is shaped the way it is and what would remove it.
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
