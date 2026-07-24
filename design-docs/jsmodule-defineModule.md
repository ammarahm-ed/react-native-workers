# `defineModule` — one typed contract, both counterparts present

> **Status: implemented** ([`src/defineModule.ts`](../src/defineModule.ts) +
> [`src/reactive.ts`](../src/reactive.ts), with a worker-prelude mirror; verified
> 60/60 in-app on iOS + Android). This refines the ergonomics of the
> [JSModule bridge](./jsmodule-bridge.md); it is pure sugar and **compiles down
> to** the low-level primitive (`worker.module` / `worker.registerModule` /
> `parent.module` / `SharedStore`), which stays as the documented escape hatch for
> dynamic cases.

## Why

Today's bridge works but the contract is smeared across three stringly-typed
places, and shared data is passed as `SharedStore` keys:

```ts
// today — forced
worker.registerModule('host', { getConfig() {…} });      // host
const calc = worker.module<Calc>('calc');                // host, separate interface
parent.module('host').getConfig();                        // worker, string key
store.set('doc', big); await calc.reflow('doc');          // hacky key passing
```

Two goals:

1. **One definition, both sides.** Write the module once; each runtime gets the
   *other* side as a typed object, so calling across feels direct — but stays
   honestly async.
2. **Shared data reads/writes like a normal object**, with the granular
   `SharedStore` node-tree doing the heavy lifting underneath — no key passing.

Non-goals (deliberately — see [Why not go further](#why-not-go-further)): putting
both *implementations* in one bundle, and making cross-thread calls *look
synchronous*.

## At a glance

The whole contract — both call directions, events both ways, and shared state —
is **one generic type** on `defineModule`, so `.worker()` / `.host()` are free to
be the *implement* terminals (no builder-vs-terminal name clash):

```ts
// calc.module.ts — imported by BOTH sides; only types + the name string survive
import { defineModule } from '@ammarahmed/react-native-workers';

export const calc = defineModule<{
  worker:     { add(a: number, b: number): number; process(id: string): Promise<Result> };
  host:       { getConfig(): Config; log(msg: string): void };
  events:     { progress: { percent: number }; done: Result };   // worker → host
  hostEvents: { cancel: { id: string } };                        // host → worker
  state:      { status: 'idle' | 'busy'; lastId: string | null; items: string[] };
}>('calc');
```

```ts
// calc.worker.ts — implement the worker half; receive the host half as `host`
import { calc } from './calc.module';

const { host, emit, on, state } = calc.worker({
  add: (a, b) => a + b,
  process: async (id) => {
    state.status = 'busy';                     // shared write → setIn under the hood
    state.items.push(id);                      // array mutator → setIn under the hood
    const cfg = await host.getConfig();        // typed, direct, awaited call to host
    const result = await work(id, cfg);
    emit('progress', { percent: 100 });        // typed event → host
    state.status = 'idle';
    state.lastId = id;
    emit('done', result);
    return result;
  },
});
on('cancel', ({ id }) => abort(id));           // typed host → worker event
```

```ts
// on the host
import { calc } from './calc.module';

const remote = calc.host(worker, {
  getConfig: () => currentConfig(),
  log: (m) => console.log(m),
});

await remote.$ready();
const r = await remote.process('img_1');        // typed call into the worker
remote.on('progress', (p) => setPct(p.percent)); // typed worker → host event
remote.emit('cancel', { id: 'img_1' });          // typed host → worker event
console.log(remote.state.status);                // shared read → getIn under the hood
```

No `registerModule`, no `parent.module('x')`, no separate interface, no store
keys. One file defines everything; both sides are symmetric and fully inferred.

## API

### The contract

One generic describes all five facets; every facet is optional. The type is the
single source of truth — everything below is derived from it by mapped types, so
there is nothing to keep in sync by hand.

```ts
interface ModuleContract {
  worker?:     Record<string, (...a: any[]) => any>; // methods the host calls
  host?:       Record<string, (...a: any[]) => any>; // methods the worker calls back into
  events?:     Record<string, any>;                  // worker → host: name → payload type
  hostEvents?: Record<string, any>;                  // host → worker: name → payload type
  state?:      object;                               // shared reactive state
}

function defineModule<C extends ModuleContract>(name: string): Module<C>;

interface Module<C extends ModuleContract> {
  worker(impl: C['worker']): WorkerSide<C>;
  host(worker: Worker, impl: C['host']): HostSide<C>;
  // typed granular subscribe (either a selector or an explicit path — see State):
  watch<R>(state: Reactive<C['state']>, sel: Selector<C['state'], R> | Path, cb: (v: R) => void): () => void;
}
```

### Worker side — `calc.worker(impl)`

```ts
type WorkerSide<C> = {
  host:  Remote<C['host']>;                                   // call host methods (async)
  emit:  <K extends keyof C['events']>(event: K, payload: C['events'][K]) => void;
  on:    <K extends keyof C['hostEvents']>(event: K, cb: (payload: C['hostEvents'][K]) => void) => () => void;
  state: Reactive<C['state']>;                                // shared state (see below)
  dispose(): void;
};
```

`impl` must satisfy `C['worker']`. `host` is the typed proxy to the host's
methods (each returns a `Promise` — `Remote<H>`). `emit` is typed to `events`
(worker→host); `on` is typed to `hostEvents` (host→worker).

### Host side — `calc.host(worker, impl)`

```ts
type HostSide<C> = Remote<C['worker']> & {                    // call worker methods (async)
  on:    <K extends keyof C['events']>(event: K, cb: (payload: C['events'][K]) => void) => () => void;
  emit:  <K extends keyof C['hostEvents']>(event: K, payload: C['hostEvents'][K]) => void;
  state: Reactive<C['state']>;
  $ready(timeoutMs?: number): Promise<void>;
};
```

`impl` must satisfy `C['host']`. The returned object *is* the worker's
`Remote<C['worker']>` (so `remote.add(2,3)` works directly), augmented with typed
`on` (worker→host events), `emit` (host→worker events), `state`, and `$ready`.

Events are symmetric: **`events`** flow worker→host (worker `emit`, host `on`);
**`hostEvents`** flow host→worker (host `emit`, worker `on`).

### `Remote<T>` (unchanged)

```ts
type Remote<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R
    ? (...a: A) => Promise<Awaited<R>>
    : never;
};
```

Works with `interface` or `type`; sync-bodied methods become async on the caller
side, which is honest (it's a real thread hop).

## Shared state that looks like a normal object

The `state` facet gives both sides a `state: Reactive<S>` object. **Typed as `S`** —
so reads and writes typecheck exactly like a plain object — while a `Proxy` maps
each access onto the granular `SharedStore` node-tree:

```ts
state.status                     // → SharedStore.getIn('calc:state', ['status'])   (lazy)
state.status = 'busy'            // → SharedStore.setIn('calc:state', ['status'], 'busy')
state.doc.meta.title             // → getIn(['doc','meta','title'])                  (lazy, one leaf)
state.doc.meta.title = 'Hi'      // → setIn(['doc','meta','title'], 'Hi')            (patch one field)
delete state.doc.draft           // → deleteIn(['doc','draft'])
'lastId' in state                // → has
Object.keys(state)               // → keys
```

Reading an object/array returns another `Proxy` that remembers its path, so deep
reads stay lazy and deep writes patch just that path. This is the same immutable
node tree we built (inline scalar leaves, structural sharing), so it is genuinely
fast — not a facade.

**Array mutators are supported.** A proxied array maps the usual mutators onto the
store's granular ops, so arrays feel normal:

```ts
state.items.push('c');          // → setIn(['items', len], 'c')
state.items[0] = 'z';           // → setIn(['items', 0], 'z')
state.items.splice(1, 1);       // → deleteIn(['items', 1])  (splice semantics)
state.items.pop();              // → deleteIn(['items', len-1])
const n = state.items.length;   // → getIn(['items']).length
for (const x of state.items) …  // iteration reads lazily
```

(`push`/`pop`/`shift`/`unshift`/`splice`/index-set are intercepted; exotic ones
like `copyWithin` fall back to read-modify-write of the whole array.)

**Writes in the same tick are batched.** Multiple synchronous assignments coalesce
into **one** atomic store update and **one** watcher notification, flushed on the
microtask tick:

```ts
state.status = 'busy';
state.lastId = id;
state.items.push(id);
// → a single batched patch; watchers fire once, not three times
```

This is backed by a new `SharedStore.batch(fn)` primitive (apply many `setIn`s
under one lock, notify once) that the reactive layer drives automatically. You
never call it directly. (An explicit `store.batch()` is also handy for the
low-level API.)

**Granular subscription** accepts either a typed **selector** or an explicit
**path** — both resolve to `subscribeIn`:

```ts
const off1 = calc.watch(state, (s) => s.doc.meta, (meta) => { … });   // selector (typed value)
const off2 = calc.watch(state, ['doc', 'meta'], (meta) => { … });     // explicit path
// both desugar to SharedStore.subscribeIn('calc:state', ['doc','meta'], …)
```

(The selector is resolved to a path at call time by running it against a
path-recording proxy — a small, well-understood trick; the explicit-path form is
the escape hatch for dynamic paths.)

### The honesty caveat (documented, not hidden)

`state` *looks* like a plain object but is **shared, concurrent, cross-thread**:

- Writes propagate to watchers **asynchronously**; a read right after a write on
  the *other* side may not see it yet.
- Writes are **last-writer-wins**. `state.count++` is read-modify-write and is
  **not atomic** across threads — two sides racing will lose updates (exactly the
  contended-writes benchmark). Per-tick batching coalesces *your own* consecutive
  writes into one patch, but it does **not** make a cross-thread read-modify-write
  atomic. For counters/accumulators, expose a worker method that does it under one
  lock, or keep per-side ownership of a key.
- Values must be **structured-cloneable** (same as messaging). Functions/class
  instances round-trip as data, not behavior.

We surface these in the type doc-comments and the guide, because a plain-object
skin that hides "this is shared memory" would mislead more than it helps.

## How it compiles to the primitive

`defineModule` is sugar. Nothing new at the native layer — it's a thin wrapper:

```ts
// calc.worker(impl) ≈
const m = new JSModule('calc', impl);                 // register worker methods
const hostMod = parent.module('calc$host');           // proxy to host methods
return {
  host: hostMod,
  emit: (ev, payload) => m.emit(ev, payload),         // 'events' → host
  on:   (ev, cb) => hostMod.$on(ev, cb),              // 'hostEvents' ← host
  state: reactive(new SharedStore('calc:state'), []), // Proxy over the store
  dispose: () => m.dispose(),
};

// calc.host(worker, impl) ≈
const hostHandle = worker.registerModule('calc$host', impl); // host methods (namespaced)
const remote = worker.module('calc');                 // proxy to worker methods
remote.on    = (ev, cb) => worker.module('calc').$on(ev, cb);   // 'events' from worker
remote.emit  = (ev, payload) => hostHandle.emit(ev, payload);   // 'hostEvents' to worker
remote.state = reactive(new SharedStore('calc:state'), []);
remote.$ready = (t) => worker.ready('calc', t);
return remote;
```

`reactive(store, path)` is the state Proxy: property `get` → `store.getIn(path…)`
(returning a nested `reactive` for objects/arrays), `set` → a batched
`store.setIn`, `deleteProperty` → `store.deleteIn`, flushed via `store.batch()`
once per microtask.

The worker half registers under `name`, the host half under `name$host`, so one
logical module owns both without a name collision — the split is invisible to
callers. Power users who need dynamic module names, or a module with no static
contract, keep using `module`/`registerModule` directly.

## Readiness & lifecycle

Unchanged semantics, nicer surface: `remote.$ready()` (host) and `parent`-side
readiness still gate on the `reg` announcement; calls before registration are
queued; unanswered calls time out. `state` needs no readiness — SharedStore is
always available and returns `undefined` for unset paths.

## Full example — a background image pipeline

```ts
// pipeline.module.ts
export const pipeline = defineModule<{
  worker: { enqueue(uri: string): Promise<string> };                 // returns output uri
  host:   { resolveAsset(uri: string): Promise<ArrayBuffer>; onError(m: string): void };
  events: { progress: { uri: string; percent: number } };
  state:  { queueLength: number; running: boolean };
}>('pipeline');
```

```ts
// pipeline.worker.ts
const { host, emit, state } = pipeline.worker({
  enqueue: async (uri) => {
    state.queueLength = (state.queueLength ?? 0) + 1;
    try {
      const bytes = await host.resolveAsset(uri);        // host reads from disk
      state.running = true;
      const out = await process(bytes, (p) => emit('progress', { uri, percent: p }));
      return out;
    } catch (e) {
      host.onError(String(e));                            // fire-and-forget-ish
      throw e;
    } finally {
      state.queueLength -= 1;
      state.running = state.queueLength > 0;
    }
  },
});
```

```ts
// screen.tsx
const worker = new Worker('./pipeline.worker');
const pipe = pipeline.host(worker, {
  resolveAsset: (uri) => FileSystem.readAsArrayBuffer(uri),
  onError: (m) => Sentry.captureMessage(m),
});
pipe.on('progress', ({ uri, percent }) => setBar(uri, percent));
const outUri = await pipe.enqueue(localUri);
// pipe.state.running / pipe.state.queueLength update live, read like a normal object
```

## Migration

The low-level API keeps working; `defineModule` is additive. A mechanical
before/after:

| Today | With `defineModule` |
| --- | --- |
| `worker.module<Calc>('calc')` | `calc.host(worker, hostImpl)` |
| `worker.registerModule('host', impl)` | folded into `calc.host(...)`'s `impl` |
| `new JSModule('calc', impl)` | `calc.worker(impl)` |
| `parent.module('host').getConfig()` | `host.getConfig()` |
| `store.set('doc', d); await m.reflow('doc')` | `state.doc = d; await m.reflow()` |

## Why not go further

Two tempting extensions we should **not** ship, and why:

- **One file with both implementations.** The worker is a separate bundle; a file
  containing host code drags host-only imports (`AsyncStorage`, navigation, native
  modules) into the worker bundle — bloat or load-time crash — unless a babel
  transform splits the file and tree-shakes each half (the Reanimated-worklet
  problem: fragile, high-maintenance). **Share the type, not the code**: one
  `*.module.ts` of pure types, two impl files.
- **Calls that look synchronous.** A call is a thread hop + two clones — genuinely
  async, can time out, can fail if the peer is gone. Hiding `await` forces either
  blocking (UI jank / deadlock) or a silently-unawaited Promise (bugs). Methods
  stay `async`; the DX win is *one typed definition*, not pretending threads are
  free. A visible `await` also discourages chatty per-iteration cross-calls — for
  hot data, read `state` locally instead of calling across.

## Resolved decisions

1. **Naming** → terminals are `calc.worker(impl)` / `calc.host(worker, impl)`; the
   contract is a single generic on `defineModule<{…}>()` (so there's no
   builder-vs-terminal clash).
2. **Host→worker events** → included now via `hostEvents` (host `emit`, worker
   `on`); `events` remain worker→host.
3. **State array mutators** → supported (`push`/`pop`/`shift`/`unshift`/`splice`/
   index-set map to `setIn`/`deleteIn`; exotic mutators fall back to whole-array
   read-modify-write).
4. **`watch`** → accepts **both** a typed selector `(s) => s.a.b` and an explicit
   path `['a','b']`.
5. **Write batching** → **batched**: synchronous assignments in a tick coalesce
   into one atomic `SharedStore.batch()` patch and a single watcher notification.

### New primitive this implies

- **`SharedStore.batch(fn)`** (+ the reactive layer that drives it): apply many
  `setIn`/`deleteIn` under one lock and emit one notification. This is a small
  native addition to [`cpp/core/SharedStore.cpp`](../cpp/core/SharedStore.cpp)
  (a batch depth counter that defers `dispatchChange` until depth hits zero,
  deduping notified paths), plus `batch`/`setInMany` on the JS wrapper + prelude.

## Implementation (done)

1. ✅ `SharedStore.batch(fn)` + `batchBegin`/`batchEnd` (native + JS + prelude + web).
2. ✅ `reactive(store)` Proxy (get/set/delete, nested proxies, array mutators,
   per-tick batched flush) — [`src/reactive.ts`](../src/reactive.ts), mirrored in
   the worker prelude; 38/38 unit tests.
3. ✅ `defineModule<C>(name)` returning `{ worker, host, watch }`, desugaring to
   `JSModule`/`registerModule`/`parent.module`/`SharedStore`.
4. ✅ In-app round-trip tests ([`example/src/primitivesTests.ts`](../example/src/primitivesTests.ts))
   + Node smoke tests; the low-level bridge API stays covered too.
5. See also [`docs/shared-data-primitives.md`](./shared-data-primitives.md) for the
   `SharedValue` / `SharedBuffer` fast paths that pair with `defineModule.state`.
