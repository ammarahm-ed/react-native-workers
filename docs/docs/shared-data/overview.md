---
sidebar_position: 1
title: Overview
---

# Shared data: the spectrum

A worker runs on its own thread with its own runtime. Moving data between the host
and a worker has a **ladder of options**, trading generality for speed. Pick the
rung that fits your workload.

| Primitive | Sync? | Cost per access | Best for |
| --- | --- | --- | --- |
| [`postMessage`](../guides/messaging) | async | copy + thread hop | one-shot handoffs |
| [JSModule bridge](../rpc/jsmodule-bridge) | async | copy + hop + RPC | typed request/response, events |
| [**`SharedStore`**](./shared-store) | **sync** | native call + mutex + tree walk | structured, watchable, granular state |
| [**`SharedValue`**](./shared-value) | **sync** | native call + **atomic** | single hot values (positions, progress) |
| [**`SharedBuffer`**](./shared-buffer) | **sync** | **one native call, then raw JS** | bulk numeric / per-frame math |

The three "sync" primitives are **local and synchronous**: they read/write native
memory on whatever thread calls them — no message, no thread hop, no `await`. That
makes them the fast path.

## How to choose

```text
Do you need a reply from the other side's code?
├─ yes → JSModule bridge / defineModule (async call)
└─ no, you just need the data:
   ├─ one number/flag, updated a lot?      → SharedValue
   ├─ a big numeric array, crunched hot?   → SharedBuffer
   ├─ structured state you want to watch?  → SharedStore  (or reactive / defineModule.state)
   └─ a one-time handoff?                  → postMessage
```

## A quick taste of each

```js
import {
  SharedStore, SharedValue, SharedBuffer,
} from '@ammarahmed/react-native-workers';

// Structured, watchable state:
const store = new SharedStore('session');
store.set('user', { name: 'Ada' });
store.subscribe('user', (key, value) => { /* changed */ });

// One hot number (lock-free):
const progress = new SharedValue('progress', 0);
progress.value = 0.5;

// Bulk shared memory:
const buf = new SharedBuffer('pixels', 1024 * Float64Array.BYTES_PER_ELEMENT);
const view = new Float64Array(buf.arrayBuffer);
view[0] = 42;
```

All three are **named** and process-global: opening the same name in any runtime
gives you the same underlying data. That data belongs to the process rather than
to any runtime, so it outlives the worker that made it — and, in development, a
JS reload. Memory is reference-counted and released once no runtime holds a
handle; `delete(name)` detaches a name deterministically.

Read [Names & lifetime](./lifetime) before you pick a name — it covers the two
mistakes the model invites (inheriting a previous run's state, and writing before
anything is subscribed).

## Performance at a glance

Pixel 5 emulator, release build, median of 4 runs:

- `SharedValue`: ~0.06 µs/op → **~17M writes/sec**, lock-free for numbers.
  ~2× faster than `SharedStore` for a single value.
- `SharedBuffer`: filling + summing a 50k `Float64Array` is **~4× faster** than
  the same data through `SharedStore` (no per-element boundary crossing).
- `SharedStore` granular `setIn`: **~12× faster** than re-sending a whole object
  over `postMessage`.

See [Performance](../performance) for the full picture.

Next: [SharedStore](./shared-store) →
