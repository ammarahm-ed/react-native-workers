---
sidebar_position: 3
title: SharedValue
---

# `SharedValue`

A `SharedValue` is a **single synchronous cell** shared by name across the host and
every worker. It's the fast primitive for hot values — a position, a progress
fraction, a gesture flag — analogous to a Reanimated shared value.

```js
import { SharedValue } from '@ammarahmed/react-native-workers';

const progress = new SharedValue('anim:progress', 0); // name, initial value
progress.value = 0.42;         // synchronous write
const x = progress.value;      // synchronous read
```

Reads and writes are **synchronous and local** — no message, no thread hop, no
`await`. Opening the same name in any runtime gives the same cell.

## Why it's fast

- **Numbers** take a **lock-free** path (`std::atomic<double>` under the hood) — no
  mutex, no serialization. Measured ~0.11 µs/op → **~8 million writes/second**.
- Other structured-cloneable values (strings, objects) go through the codec under
  a light lock.
- Writes notify subscribers **only if there are any** — a hot read/write loop that
  nobody watches pays zero notification cost.

It's ~3× faster than doing the same with a single `SharedStore` key, because there's
no string key, hash map, or tree walk — just the cell.

## Cross-runtime example

```js
// Host
const scroll = new SharedValue('scroll:y', 0);

// Worker computes a parallax offset from the shared scroll position
const worker = new Worker({
  inline: `
    const scroll = new SharedValue('scroll:y');
    const offset = new SharedValue('parallax:offset', 0);
    setInterval(() => {
      offset.value = scroll.value * 0.5; // read one cell, write another, no messaging
    }, 16);
  `,
});

// The host updates scroll:y as the user scrolls; the worker reacts instantly.
onScroll((y) => { scroll.value = y; });
```

## Subscribing (optional)

Most hot loops just **read** the value each frame and don't need notifications. When
you do want to react to changes:

```js
const flag = new SharedValue('paused', false);
const off = flag.subscribe((v) => console.log('paused =', v));
// ...later
off();
```

Change notifications fire on the subscriber's own runtime thread. Numbers you
write in a tight loop with no subscribers stay fully lock-free.

## When to use which

- **One or a few hot scalars** → `SharedValue`.
- **A structured object you want to watch/patch** →
  [`SharedStore`](./shared-store).
- **A big numeric array crunched in a loop** →
  [`SharedBuffer`](./shared-buffer).

## API

| Member | Description |
| --- | --- |
| `new SharedValue(name, initial?)` | Open/create a named cell |
| `.value` (get/set) | Synchronous read / write |
| `.subscribe(cb)` | Observe changes; returns an unsubscribe function |

:::note
`SharedValue` is designed for numbers and small values. For arrays of numbers,
`SharedBuffer` is dramatically faster.
:::

## Lifetime

The cell belongs to the process, not to the runtime that opened it, and its
memory is released once no runtime holds a handle. `SharedValue.delete(name)`
detaches a name deterministically — useful for dynamically named cells that would
otherwise accumulate.

→ [Names & lifetime](./lifetime)
