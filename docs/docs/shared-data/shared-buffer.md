---
sidebar_position: 4
title: SharedBuffer
---

# `SharedBuffer`

A `SharedBuffer` is a **named block of raw shared memory**. Every runtime that opens
the same name gets an `ArrayBuffer` over the **same native bytes**, so typed-array
views in different runtimes read and write the same memory — true zero-copy shared
memory. It's the fastest option for bulk numeric work.

```js
import { SharedBuffer } from '@ammarahmed/react-native-workers';

const buf = new SharedBuffer('sim', 1000 * Float64Array.BYTES_PER_ELEMENT);
const view = new Float64Array(buf.arrayBuffer); // a normal typed array...
view[0] = 3.14;                                  // ...over shared memory
```

## Why it's the fastest

With a `SharedValue` or `SharedStore`, each element you touch crosses the JS↔native
boundary (one host call). With a `SharedBuffer` you pay **one** host call to get the
`ArrayBuffer`, then all reads/writes are **plain JavaScript** on a typed array — no
per-element boundary crossing at all.

Filling and summing a 50,000-element `Float64Array` is **~6–10× faster** than the
same data through `SharedStore`. This is the case that beats per-cell primitives —
ours *and* comparable ones like worklet shared values — because bulk math stays in
one runtime over shared memory.

:::info[No `SharedArrayBuffer` needed]
Hermes doesn't support JavaScript's `SharedArrayBuffer`. `SharedBuffer` sidesteps
that: the bytes are owned in native code, and each runtime is handed a normal
`ArrayBuffer` that points at them. You get shared-memory semantics without the JS
feature.
:::

## Cross-runtime example

```js
// Host — allocate and seed the buffer
const buf = new SharedBuffer('particles', 3 * 1000 * Float64Array.BYTES_PER_ELEMENT);
const data = new Float64Array(buf.arrayBuffer); // [x0,y0,vx0, x1,y1,vx1, ...]

// Worker — step the simulation over the SAME memory, no copying
const worker = new Worker({
  inline: `
    const buf = new SharedBuffer('particles', 3 * 1000 * 8);
    const p = new Float64Array(buf.arrayBuffer);
    setInterval(() => {
      for (let i = 0; i < p.length; i += 3) {
        p[i]     += p[i + 2];   // x += vx
        p[i + 1] += 0.1;        // gravity
      }
    }, 16);
  `,
});

// The host can read the latest positions any time — same bytes:
requestAnimationFrame(function draw() {
  render(data);
  requestAnimationFrame(draw);
});
```

## Synchronization

A `SharedBuffer` is **raw memory with no built-in synchronization**. If two runtimes
write overlapping regions at the same time, they race (and multi-byte values can
tear). You have two safe patterns:

### 1. A critical section with `withLock`

Every buffer has a named, cross-runtime lock:

```js
buf.withLock(() => {
  // only one runtime runs this block at a time (for this buffer's name)
  view[0] += 1;
  view[1] += 1;
});
```

`withLock(fn)` returns whatever `fn` returns. It's recursive (re-entrant on the same
thread). Keep critical sections short — the lock blocks other runtimes.

### 2. Single-writer / double-buffer

Often the cleanest approach is to avoid locks entirely: have **one** writer per
region, or use two buffers and swap (one being written, one being read).

## API

| Member | Description |
| --- | --- |
| `new SharedBuffer(name, byteLength)` | Open/create a named buffer (first opener fixes the size) |
| `.arrayBuffer` | An `ArrayBuffer` over the shared memory — put a typed-array view on it |
| `.byteLength` | Size in bytes |
| `.withLock(fn)` | Run `fn` holding the buffer's cross-runtime lock; returns `fn`'s result |

## When to use which

- **Bulk numeric arrays / per-frame math** → `SharedBuffer`.
- **A single hot number** → [`SharedValue`](./shared-value).
- **Structured, watchable state** → [`SharedStore`](./shared-store).

## Lifetime

The block belongs to the process and is released once no runtime holds a handle.
`SharedBuffer.delete(name)` detaches a name deterministically — worth doing for
buffers in particular, since they are the largest allocation of the three and
their `byteLength` is fixed by whoever opens the name first.

→ [Names & lifetime](./lifetime)
