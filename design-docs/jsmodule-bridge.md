# JSModule bridge — typed two-way RPC between host and worker

A worker runs your JavaScript in a **separate Hermes runtime on its own thread**.
The JSModule bridge lets the two runtimes call each other's functions as if they
were local `async` functions — the same shape as JS → Native → Java method calls,
but here it's **JS → (native message channel) → JS**.

```
┌─────────────── host runtime ───────────────┐        ┌───────────── worker runtime ─────────────┐
│  const calc = worker.module<Calc>('calc')   │        │  new JSModule('calc', { add(a,b){…} })    │
│  await calc.add(2, 3)  // 5                  │──call─▶│  add(2,3) ──▶ 5                            │
│                                             │◀─res───│                                           │
│  worker.registerModule('host', { … })       │◀─call──│  await parent.module('host').getConfig()  │
│  calc.$on('progress', p => …)               │◀─evt───│  calc.emit('progress', { percent })       │
└─────────────────────────────────────────────┘        └───────────────────────────────────────────┘
```

Both directions are symmetric: **either side can register modules the other side
calls, and either side can emit events the other side listens to.** It is fully
typed, so calling a worker method feels like calling a local `async` function.

## Table of contents

- [Quick start](#quick-start)
- [Typing it](#typing-it)
- [Two-way calls](#two-way-calls-worker--host)
- [Events](#events)
- [Readiness](#readiness-when-is-the-worker-loaded)
- [Fast data: SharedStore for params & state](#fast-data-sharedstore-for-params--state)
- [Sync vs async — what "sync" means here](#sync-vs-async--what-sync-means-here)
- [How it works](#how-it-works)
- [Wire protocol](#wire-protocol)
- [Performance](#performance)
- [Reference](#api-reference)
- [Limitations & roadmap](#limitations--roadmap)

## Quick start

**Worker** (`workers/calc.js`, or an inline string). `JSModule` is a global in
every worker:

```js
new JSModule('calc', {
  add(a, b) {
    return a + b; // sync body — exposed to the host as async
  },
  async fetchUser(id) {
    const res = await someAsyncThing(id);
    return res;
  },
});
```

**Host**:

```ts
import { Worker } from '@ammarahmed/react-native-workers';

const worker = new Worker('./workers/calc');
const calc = worker.module('calc');

await worker.ready('calc'); // optional: wait until the worker registered it
const sum = await calc.add(2, 3); // 5  — real call into the worker thread
const user = await calc.fetchUser(42);
```

That's the whole happy path: register on one side, `.module(name)` on the other,
`await` the methods.

## Typing it

Declare the module's shape once and share it between both files. Method bodies
may be sync or async; on the calling side **every method returns a `Promise`**
(it's a real cross-thread call), which `Remote<T>` expresses for you:

```ts
// calc.contract.ts  (imported by both the worker and the host)
export interface Calc {
  add(a: number, b: number): number;
  fetchUser(id: number): Promise<{ id: number; name: string }>;
}
```

```ts
// host.ts
import type { Calc } from './calc.contract';

const calc = worker.module<Calc>('calc');
const sum: number = await calc.add(2, 3); // ✅ typed args + result
await calc.add('nope', 3); // ✗ compile error
```

`Remote<Calc>` maps each method `(...args) => R` to `(...args) => Promise<Awaited<R>>`,
and adds `.$on(event, cb)` and `.$ready()`. In the worker, annotate the impl with
`satisfies Calc` to keep it honest:

```ts
new JSModule('calc', {
  add: (a, b) => a + b,
  fetchUser: async (id) => ({ id, name: 'Ada' }),
} satisfies Calc);
```

## Two-way calls (worker → host)

The host registers a module; the worker calls it via the `parent` global:

```ts
// host
worker.registerModule('storage', {
  read: (key: string) => AsyncStorage.getItem(key),
  write: (key: string, val: string) => AsyncStorage.setItem(key, val),
});
```

```js
// worker
const cached = await parent.module('storage').read('profile');
await parent.module('storage').write('profile', JSON.stringify(next));
```

This is how a worker reaches host-thread-only capabilities (a UI-affine native
module, the app's storage, network with app cookies…) without those living in the
worker at all.

## Events

Modules are also event emitters — fire-and-forget, one-way, no reply:

```js
// worker
const jobs = new JSModule('jobs', {
  start() {
    run().then((r) => jobs.emit('done', r));
    return true;
  },
});
jobs.emit('progress', { percent: 0 });
```

```ts
// host
const jobs = worker.module('jobs');
const off = jobs.$on('progress', (p) => setProgress(p.percent));
jobs.$on('done', (result) => { off(); render(result); });
await jobs.start();
```

Host → worker events work the same way through a host-registered module:

```ts
const h = worker.registerModule('host', { … });
h.emit('theme-changed', { dark: true });     // host emits
```

```js
parent.module('host').$on('theme-changed', (t) => applyTheme(t)); // worker listens
```

## Readiness — when is the worker loaded?

Calls made before the worker registers a module are **queued**, not dropped: the
worker registers its modules during top-level evaluation, which runs before it
processes any posted call, so a call sent immediately after `new Worker(...)` is
handled as soon as the module exists. When you want to gate explicitly:

```ts
await worker.ready('calc');            // resolves when the worker registers 'calc'
await worker.module('calc').$ready();  // same, from the proxy
```

`ready()` rejects after a timeout (default 15s) so a never-registered module
surfaces as an error instead of hanging.

## Fast data: SharedStore for params & state

RPC arguments and results are structured-cloned across the thread boundary — the
same cost as `postMessage`. For **large or frequently-updated** data, don't ship
it in every call; put it in a [`SharedStore`](../README.md#shared-state-between-workers-sharedstore)
and pass a small **reference**. SharedStore is synchronous, mutex-guarded shared
memory with lazy reads and granular (`setIn`) patching:

```ts
// host: publish once, then patch granularly
const store = new SharedStore('session');
store.set('doc', bigDocument);
// … later, change one field without re-sending the whole doc:
store.setIn('doc', ['user', 'name'], 'Ada');

await worker.module('editor').reflow('doc'); // pass the KEY, not the document
```

```js
// worker: read straight from shared memory (no round-trip, lazy decode)
new JSModule('editor', {
  reflow(key) {
    const title = store.getIn(key, ['meta', 'title']); // decodes one field
    // …
  },
});
```

This turns a repeated "send the whole state" pattern into "patch one field +
call with a key" — see the [benchmark](#performance) (~N× less marshalling for
large params).

## Sync vs async — what "sync" means here

Each worker is a **single-threaded Hermes runtime on its own thread**. That gives
two kinds of "synchronous", and one deliberate non-goal:

| You want… | Use | Synchronous? |
| --- | --- | --- |
| Read/patch shared **data** with no round-trip | `SharedStore` `get`/`getIn`/`setIn` | **Yes** — mutex-guarded, both threads |
| **Invoke** a function on the other runtime | `module(...).method()` | No — returns a `Promise` |
| Fire-and-forget notification | `module.emit` / `$on` | n/a (async delivery) |

A blocking, synchronous *invocation* across the boundary (à la RN's
`isBlockingSynchronousMethod`) is intentionally **not** offered: RN's sync methods
run *native* code on the JS thread, whereas here the target is another **JS
runtime on another thread** that can't be re-entered while it's executing. A true
blocking call would have to park the caller thread until the target thread picks
it up — which janks the UI thread and risks deadlock if the two ever block on each
other. The synchronous-data answer (`SharedStore`) covers the real motivation:
**"I need the value now, without a round-trip."** Put the value in the store; both
sides read it synchronously. (If a genuine blocking call is ever required, it
would need a native semaphore + a re-entrant message pump — see
[roadmap](#limitations--roadmap).)

## How it works

The bridge is a thin JS layer over the **existing worker message channel** — no
new native threads or blocking primitives:

1. Each side holds a **bridge endpoint** with a registry of local modules, a map
   of outstanding calls (`cid → {resolve, reject}`), and event listeners.
2. `module(name)` returns a `Proxy`; accessing a method returns a function that
   serializes `(name, method, args)` into a **call** envelope, assigns a
   correlation id, and `postMessage`s it.
3. The other side's endpoint receives the envelope, invokes
   `module[method](...args)`, awaits the result (bodies may be sync or async), and
   posts a **result** envelope back with the same id, which resolves the caller's
   `Promise`. Thrown errors travel back as rejections.
4. Bridge envelopes are **multiplexed** over the same channel as user
   `postMessage` traffic, tagged with a reserved key (`__rnwb`). Each side
   intercepts tagged messages before they reach the user's `onmessage`, so the
   bridge and raw messaging coexist.

The same ~120-line endpoint runs on both sides: [`src/bridge.ts`](../src/bridge.ts)
(host, typed) and a hand-written mirror in the worker prelude
([`cpp/bindings/WorkerPrelude.h`](../cpp/bindings/WorkerPrelude.h)).

## Wire protocol

Every message carries `__rnwb: 1`. Kinds:

| `k` | Fields | Meaning |
| --- | --- | --- |
| `reg` | `mod` | a module was registered on the sender (drives `ready`) |
| `call` | `cid, mod, fn, args` | invoke `mod.fn(...args)`; reply referencing `cid` |
| `res` | `cid, ok, value \| error` | result (or error) of a call |
| `evt` | `mod, ev, args` | one-way event from a module |

Calls to a not-yet-registered module are queued by the receiver and flushed when
it registers; unanswered calls reject on a timeout. Args, results, and event
payloads must be **structured-cloneable** (no functions/proxies) — pass large data
by `SharedStore` reference instead.

## Teardown

`worker.terminate()` disposes the host endpoint. Every call still in flight is
rejected — it can never complete — with a typed error:

```ts
class WorkerTerminatedError extends Error {
  name = 'WorkerTerminatedError';
  code = 'ERR_WORKER_TERMINATED';
}
```

The subtlety is **unhandled rejections**. The normal way to invoke a method whose
result you don't need is fire-and-forget (`w.module('x').flush()`), which leaves
the promise with no handler attached. Rejecting it then surfaces as
`Uncaught (in promise)` — but unmounting a screen while a call is in flight is
ordinary, not an error.

The fix: each `Pending` entry keeps a reference to the promise it handed out, and
`dispose` attaches its own no-op handler **before** rejecting.

```ts
p.promise.catch(() => {});   // marks handled; does NOT consume the rejection
p.reject(new WorkerTerminatedError(p.what));
```

An extra handler does not stop other consumers seeing the rejection, so callers
that did `await` still get their error. Pending `ready()` waiters are cancelled
the same way — otherwise their timeout fires long after the worker is gone and
rejects with a misleading *"module X not ready after 15000ms"*.

The worker-side mirror in the prelude needs no equivalent: the worker runtime is
destroyed wholesale, so its pending promises die with it rather than rejecting
into a live runtime.

**Known gap — no drain.** `terminate()` does not flush queued outgoing calls, so
a fire-and-forget call issued immediately before it may never execute:

```ts
return () => {
  w.module('job').flush(); // may not run
  w.terminate();
};
```

Awaiting it is the correct fix but a React cleanup function cannot await. An
opt-in `await w.terminate({ drain: true })` is the natural follow-up. Note that
shared data needs no such call — it is reference-counted and released when the
worker dies and the host drops its handles.

## Performance

From the example app's benchmark suite (debug build; release is faster):

- **RPC round-trip latency**: a call + reply is on the order of a `postMessage`
  round-trip (hundreds of µs to low-ms in debug), dominated by the two structured
  clones + thread hop — not by the bridge bookkeeping.
- **Param marshalling**: summing a 5,000-element array in the worker, passing it
  **inline by value** vs **by `SharedStore` reference**, shows the store reference
  avoiding the per-call clone/transfer of the array (it ships only the key).

See `example/src/bench.ts` (`bridge RPC round-trip`, `bridge 5k-array param`).

## API reference

### Host (`Worker`)

```ts
worker.module<T>(name: string): Remote<T>;
worker.registerModule(name: string, impl: Record<string, Fn>): ModuleHandle;
worker.ready(name: string, timeoutMs?: number): Promise<void>;
```

`Remote<T>` = each `T` method as `(...args) => Promise<Awaited<R>>`, plus:

```ts
proxy.$on(event: string, cb: (...args) => void): () => void; // returns unsubscribe
proxy.$ready(timeoutMs?: number): Promise<void>;
```

`ModuleHandle`:

```ts
handle.emit(event: string, ...args: any[]): void;
handle.dispose(): void;
```

### Worker (globals)

```js
new JSModule(name, impl);   // register; instance has .emit(event, ...args), .dispose()
parent.module(name);        // Remote proxy for a host module (+ .$on / .$ready)
parent.register(name, impl);// register a worker module (same as new JSModule)
parent.ready(name, ms?);    // resolve when the host registers `name`
```

## Limitations & roadmap

- **Structured-cloneable payloads only.** Functions/proxies can't cross the
  boundary; pass large data by `SharedStore` reference.
- **No blocking sync invocation** (by design — see
  [above](#sync-vs-async--what-sync-means-here)). A future opt-in blocking call
  would add a native semaphore + a re-entrant pump on the caller thread, with a
  timeout and a no-nested-sync guard to prevent deadlock.
- **Typed events** are currently `$on(event: string, cb)`. A typed events map
  (`Remote<T, Events>`) is a straightforward follow-up.
- **Nested workers**: the bridge is wired host↔worker; a worker↔child-worker
  bridge can reuse the same endpoint over the child's channel (follow-up).
  Child workers today talk to their coordinator over plain
  `postMessage`/`onmessage`, which is adequate for map-reduce fan-out (see the
  parallel-parse example) but has no typing, no correlation ids and no events.
- **No drain on terminate** — see [Teardown](#teardown).
