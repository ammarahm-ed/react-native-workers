---
sidebar_position: 1
title: JSModule bridge
---

# JSModule bridge

The JSModule bridge lets the host and a worker **call each other's functions** as if
they were local `async` functions — a two-way RPC layer over the message channel.
It's the low-level primitive; for a fully-typed, ergonomic version see
[`defineModule`](./define-module).

```text
host  ──  await calc.add(2, 3)  ──▶  worker runs add(2,3) ──▶ 5  ──▶  host
```

## A first call: worker → host exposes a module

In the worker, register a **module** — a set of methods the host can call:

```js
const worker = new Worker({
  inline: `
    new JSModule('calc', {
      add: (a, b) => a + b,
      async slow(x) {
        await new Promise((r) => setTimeout(r, 100));
        return x * 10;
      },
    });
  `,
});
```

On the host, get a proxy to that module and call it — every method returns a
`Promise`:

```js
const calc = worker.module('calc');

const sum = await calc.add(2, 3);   // 5
const slow = await calc.slow(4);    // 40

await worker.ready('calc');         // optional: wait until the worker registered it
```

Method bodies can be sync or async; on the calling side they're always `async`
(it's a real cross-thread call).

## Two-way: the worker calls back into the host

Register a module on the **host** too, and the worker reaches it via the global
`parent`:

```js
// host
worker.registerModule('storage', {
  read: (key) => AsyncStorage.getItem(key),
  write: (key, val) => AsyncStorage.setItem(key, val),
});
```

```js
// worker
const cached = await parent.module('storage').read('profile');
await parent.module('storage').write('profile', 'Ada');
```

This is how a worker reaches host-thread-only capabilities (storage, network with
app cookies, a UI-affine module) without those living in the worker.

## Events

Modules are also event emitters — fire-and-forget, one-way:

```js
// worker
const jobs = new JSModule('jobs', {
  start() {
    let pct = 0;
    const id = setInterval(() => {
      pct += 25;
      jobs.emit('progress', { pct });
      if (pct >= 100) { clearInterval(id); jobs.emit('done'); }
    }, 50);
    return true;
  },
});
```

```js
// host
const jobs = worker.module('jobs');
const off = jobs.$on('progress', (p) => setBar(p.pct));
jobs.$on('done', () => { off(); });
await jobs.start();
```

## Errors

An error thrown in a module method rejects the caller's promise with the same
message:

```js
// worker: fail: () => { throw new Error('nope'); }
try {
  await worker.module('calc').fail();
} catch (e) {
  console.log(e.message); // 'nope'
}
```

### Termination

`worker.terminate()` rejects every call still in flight — they can never
complete — with a `WorkerTerminatedError`:

```js
import { WorkerTerminatedError } from '@ammarahmed/react-native-workers';

try {
  await worker.module('calc').slow();
} catch (e) {
  if (e.code === 'ERR_WORKER_TERMINATED') return; // expected during teardown
  throw e;
}
```

Pending `ready()` waiters are rejected the same way, rather than surfacing a
misleading timeout long after the worker is gone.

Calls you deliberately **don't** await — the normal way to invoke a method whose
result you don't need — do not produce an unhandled-rejection warning when the
worker is torn down. Tearing down mid-call is ordinary (a screen unmounts while a
call is in flight), so it is not reported as an error.

One thing to be aware of: a fire-and-forget call issued immediately before
`terminate()` may not execute at all. If a final call must run, await it — which
a React cleanup function cannot do:

```js
useEffect(() => {
  const w = new Worker('./job');
  return () => {
    w.module('job').flush(); // may not run — terminate does not drain
    w.terminate();
  };
}, []);
```

Prefer designing teardown so it doesn't need a final call. Shared data does not
need one: it is reference-counted, so it is released when the worker dies and the
host drops its handles ([Names & lifetime](../shared-data/lifetime)).

## Passing big data efficiently

RPC arguments are structured-cloned across the boundary (same cost as
`postMessage`). For **large or frequently-updated** arguments, don't ship them in
every call — put them in a [`SharedStore`](../shared-data/shared-store) and pass a
small **key**:

```js
// host
store.set('doc', bigDocument);
await worker.module('editor').reflow('doc'); // pass the key, not the document

// worker
new JSModule('editor', {
  reflow(key) {
    const doc = new SharedStore('...').get(key); // read from shared memory
  },
});
```

## Readiness

Calls made before the worker registers a module are **queued**, not lost — the
worker registers its modules during startup, before it processes any call. To gate
explicitly:

```js
await worker.ready('calc');           // resolves when the worker registers 'calc'
await worker.module('calc').$ready();  // same, from the proxy
```

`ready` rejects after a timeout (default 15s) so a never-registered module surfaces
as an error rather than hanging.

## Reference

**Host (`Worker`):**

| Method | Description |
| --- | --- |
| `worker.module(name)` | Proxy to call a worker module (methods → `Promise`) |
| `worker.registerModule(name, impl)` | Expose a host module; returns `{ emit, dispose }` |
| `worker.ready(name, timeoutMs?)` | Resolve when the worker registers `name` |
| `worker.terminate()` | Stop the worker; in-flight calls reject with `WorkerTerminatedError` |
| `proxy.$on(event, cb)` | Subscribe to a module's events (returns unsubscribe) |
| `proxy.$ready(timeoutMs?)` | Same as `worker.ready` |

**Worker (globals):**

| API | Description |
| --- | --- |
| `new JSModule(name, impl)` | Register a module; instance has `.emit(event, ...args)` |
| `parent.module(name)` | Proxy to call a host module |
| `parent.register(name, impl)` | Expose a worker module (same as `new JSModule`) |

:::tip[Prefer `defineModule`]
`defineModule` wraps all of this in a single **typed** contract where both sides are
inferred from one definition. Reach for it first; use the raw bridge for dynamic
module names or advanced cases. → [defineModule](./define-module)
:::

Arguments, results, and event payloads must be **structured-cloneable** (no
functions). Pass large data by `SharedStore` reference.
