---
sidebar_position: 5
title: Reactive state
---

# Reactive state

`reactive()` wraps a [`SharedStore`](./shared-store) key so you can read and write
shared state like a **plain JavaScript object** — while the granular `getIn`/`setIn`
machinery does the work underneath.

```js
import { SharedStore, reactive } from '@ammarahmed/react-native-workers';

const store = new SharedStore('editor');
const state = reactive(store); // a normal-looking object backed by the store

state.title = 'Untitled';           // → setIn under the hood
state.user = { name: 'Ada' };
console.log(state.user.name);       // → lazy getIn under the hood
state.tags = ['a', 'b'];
state.tags.push('c');               // array mutators work
delete state.title;                 // → deleteIn under the hood
```

No paths, no `set`/`get` calls — it reads and writes like an object, but it's shared
memory that any runtime can see.

## What's supported

- **Reads** — property access decodes lazily (`state.a.b.c` decodes just that leaf).
- **Writes** — assignment patches one path.
- **Nested objects** — `state.user.name = 'Grace'` patches only `user.name`.
- **Arrays** — index get/set, `length`, iteration (`for...of`), read methods
  (`map`, `filter`, `indexOf`, …), and mutators (`push`, `pop`, `shift`, `unshift`,
  `splice`, …).
- **`delete`**, the `in` operator, `Object.keys`, spread, `JSON.stringify`.

## Batched writes

Assignments made in the **same tick** are automatically coalesced into a single
store update and a single watcher notification:

```js
state.title = 'Report';
state.author = 'Ada';
state.tags.push('draft');
// → one batched patch; anyone watching the store is notified once, next microtask.
```

Reads stay consistent immediately (`state.title` returns `'Report'` right away); only
the notification is deferred.

## The honesty caveat

`state` *looks* like a plain object, but it is **shared, concurrent, cross-thread**
memory:

- Writes propagate to watchers **asynchronously**; a read on the *other* side right
  after a write may not see it yet.
- Writes are **last-writer-wins**. `state.count++` is a read-modify-write and is
  **not atomic** across runtimes — two sides racing can lose updates. For shared
  counters, funnel updates through one worker or use a
  [`SharedBuffer`](./shared-buffer) with a lock.

Treat it as convenient sugar over shared state, not as thread-safe local memory.

## Watching a slice

To react to changes in the reactive tree, subscribe to a path on the underlying
store (or use [`defineModule`](../rpc/define-module)'s `watch`, which is typed):

```js
store.subscribeIn('state', ['user'], (relPath, value) => {
  // fires when anything under state.user changes
});
```

## Where it shines

`reactive` is what backs the `state` facet of [`defineModule`](../rpc/define-module),
giving a module a shared state object both the host and worker read/write naturally.
Use it for structured app state; drop to [`SharedValue`](./shared-value) /
[`SharedBuffer`](./shared-buffer) for the hot numeric paths.
