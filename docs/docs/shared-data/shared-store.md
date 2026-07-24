---
sidebar_position: 2
title: SharedStore
---

# `SharedStore`

A `SharedStore` is a **named key–value store shared across the host and all
workers**, with synchronized reads/writes, change watchers, and — crucially — the
ability to read and update **parts** of a value without touching the rest.

```js
import { SharedStore } from '@ammarahmed/react-native-workers';

const store = new SharedStore('session'); // same name = same store, everywhere
store.set('user', { id: 1, name: 'Ada' });
const user = store.get('user'); // { id: 1, name: 'Ada' }
```

Opening `new SharedStore('session')` in a worker gives you the **same** data:

```js
const worker = new Worker({
  inline: `
    const store = new SharedStore('session');
    self.onmessage = () => self.postMessage(store.get('user').name);
  `,
});
worker.onmessage = (e) => console.log(e.data); // 'Ada'
```

## Basic operations

```js
store.set('count', 0);          // write
store.get('count');             // read → 0
store.has('count');             // → true
store.delete('count');          // → true
store.keys();                   // → ['user', ...]
```

Values may be any structured-cloneable data (objects, arrays, `Date`, typed
arrays, …).

## Lazy reads

`get` returns a **snapshot proxy** for objects and arrays. Nested fields are only
decoded when you actually access them, so reading one field of a large object is
cheap:

```js
store.set('doc', { title: 'Report', body: hugeString, meta: { rev: 3 } });

const doc = store.get('doc'); // nothing decoded yet
console.log(doc.meta.rev);    // decodes ONLY meta.rev
// doc.body is never decoded because you never touched it
```

The snapshot reflects the store **as of the `get` call** — later writes by other
runtimes don't change it. Call `get` again for a fresh view.

You can also read a nested value directly:

```js
store.getIn('doc', ['meta', 'rev']); // 3 — decodes just this
```

## Granular updates

This is where `SharedStore` beats message passing. Instead of replacing a whole
value, patch **one path**:

```js
store.set('doc', { user: { name: 'Ada', age: 30 }, tags: ['a', 'b'] });

store.setIn('doc', ['user', 'age'], 31);   // update one field
store.setIn('doc', ['tags', 1], 'B');       // array indices work too
store.merge('doc', { user: { age: 32 } });  // deep-merge a partial object
store.deleteIn('doc', ['tags', 0]);         // remove (arrays splice)
```

`setIn` encodes **only the new value** and rebuilds only the path from the root to
that field — the rest of the document is untouched and shared. Updating one field
of a 200-field object is **~4× cheaper** than re-sending the whole object over
`postMessage`, and independent of the object's total size.

## Watching for changes

```js
// Fire whenever a key changes (value is the whole new value):
const off = store.subscribe('user', (key, value) => {
  console.log(key, 'changed to', value);
});
off(); // unsubscribe

// Fire only when a sub-path changes; receive just the delta:
const off2 = store.subscribeIn('doc', ['user'], (relPath, value) => {
  // e.g. relPath = ['age'], value = 31
});

// Fire on ANY key change:
const off3 = store.watch((key, value) => { /* ... */ });
```

Watchers are delivered **asynchronously** on each runtime's own thread. A worker
that writes a value notifies host watchers, and vice-versa.

## Batching

Multiple writes can be coalesced into **one** notification:

```js
store.batch(() => {
  store.setIn('doc', ['user', 'name'], 'Grace');
  store.setIn('doc', ['user', 'age'], 33);
  store.setIn('doc', ['tags', 0], 'x');
});
// writes apply immediately (reads inside the batch are consistent);
// watchers fire ONCE per changed key, after the batch.
```

## A complete example: shared counter with a live view

```js
// Host
const store = new SharedStore('game');
store.set('score', 0);
store.subscribe('score', (_k, v) => updateScoreLabel(v));

// Worker — increments the score off the JS thread
const worker = new Worker({
  inline: `
    const store = new SharedStore('game');
    self.onmessage = (e) => {
      const cur = store.get('score') | 0;
      store.set('score', cur + e.data);
    };
  `,
});

worker.postMessage(10); // host's subscribe fires with 10
```

:::caution[Atomicity]
A read-modify-write like the counter above is **not atomic across threads** — if
two runtimes do it at the same time, one update can be lost (last-writer-wins). For
a shared counter that multiple runtimes bump concurrently, funnel the increments
through a single worker, or use a [`SharedBuffer`](./shared-buffer) with a lock.
:::

## API summary

| Method | Description |
| --- | --- |
| `get(key)` | Lazy snapshot read |
| `getIn(key, path)` | Read one nested value |
| `set(key, value)` | Replace a value |
| `setIn(key, path, value)` | Update one nested value |
| `merge(key, partial)` | Deep-merge an object |
| `deleteIn(key, path)` | Remove a nested value (arrays splice) |
| `has(key)` / `delete(key)` / `keys()` | Presence / remove / list |
| `subscribe(key, cb)` | Watch a key (whole value) |
| `subscribeIn(key, path, cb)` | Watch a sub-path (delta) |
| `watch(cb)` | Watch all keys |
| `batch(fn)` | Coalesce writes into one notification |

For a plain-object feel over a store, see [reactive state](./reactive-state).

## Lifetime

A store belongs to the process, not to the runtime that opened it: it outlives
the worker that created it and, in development, a JS reload. Memory is released
once no runtime holds a handle; `SharedStore.delete(name)` detaches the name
deterministically (without unsubscribing existing listeners).

Note that a store carries no history — a write with no subscriber is observed by
nobody, so subscriptions must be established before you start producing.

→ [Names & lifetime](./lifetime)
