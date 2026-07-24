# Shared-data primitives

A worker runs on its own thread with its own Hermes runtime. Moving data between
runtimes has a spectrum of tools, trading generality for speed. Pick the rung that
fits the workload — from async message passing to raw shared memory.

| Primitive | Sync? | Cost per access | Best for |
| --- | --- | --- | --- |
| `postMessage` | async | clone + thread hop | one-shot handoffs |
| [JSModule bridge](./jsmodule-bridge.md) | async | clone + hop + RPC | typed coordination / calls |
| **`SharedStore`** | **sync** | host call + mutex + map + node walk | structured, watchable, granular state |
| **`SharedValue`** | **sync** | host call + **atomic** | single hot values (worklet-style shared value) |
| **`SharedBuffer`** | **sync** | **1 host call for the view, then raw JS** | bulk numeric / per-frame math |

All three "sync" primitives are **local and synchronous** — they hit native memory
on whatever thread calls them, with no message and no thread hop. That's the same
model as a Reanimated shared value, so the throughput ceiling is the JSI host-call
cost, not messaging.

Measured (Pixel_5 emulator, debug; release is faster):

- **`SharedValue`**: ~0.11 µs/op read, ~0.12 µs/op write → **~8M writes/sec**,
  lock-free for numbers. **~3× faster** than `SharedStore` for a single value.
- **`SharedBuffer`**: filling + summing a 50k `Float64Array` is **~6–10× faster**
  than the same data through `SharedStore` (no per-element host calls at all).
- **`SharedStore.batch`**: coalesces N writes into 1 watcher notification.

## `SharedValue` — one synchronous cell

```ts
import { SharedValue } from '@ammarahmed/react-native-workers';

const progress = new SharedValue('anim:progress', 0); // named, shared by every runtime
progress.value = 0.42; // synchronous write
const x = progress.value; // synchronous read

const off = progress.value; // (numbers take a lock-free atomic path)
const unsub = progress.subscribe((v) => console.log('changed', v)); // optional
```

- The same name opens the **same cell** in the host and every worker; reads/writes
  are synchronous and local (no round-trip).
- **Numbers** use a lock-free `std::atomic<double>` — no mutex, no contention, no
  structured-clone. Other structured-cloneable values go through the codec under a
  light lock.
- Writes notify `subscribe` listeners **only when there are any** — a hot
  read/write loop that nobody watches pays zero notification cost.

Use it for the handful of hot scalars an animation/gesture/physics loop touches.

## `SharedBuffer` — raw shared memory

```ts
import { SharedBuffer } from '@ammarahmed/react-native-workers';

const buf = new SharedBuffer('sim:particles', 50000 * Float64Array.BYTES_PER_ELEMENT);
const view = new Float64Array(buf.arrayBuffer); // SAME memory in every runtime
for (let i = 0; i < view.length; i++) view[i] = step(view[i]); // full-speed JS

buf.withLock(() => {           // cross-runtime critical section
  view[0] += 1;
});
```

- Every runtime that opens the same name gets an `ArrayBuffer` over the **same
  native bytes** (via a shared `MutableBuffer`), so typed-array views alias the same
  memory — true zero-copy shared memory, without JS `SharedArrayBuffer` (which
  Hermes lacks).
- It is **raw memory with no implicit synchronization**: concurrent overlapping
  writes from two runtimes race (torn multi-byte values). Pair it with `withLock`
  (a named, recursive cross-runtime lock) or a single-writer / double-buffer
  discipline. For bulk math this is the fastest option — it beats per-cell
  primitives (ours *and* worklets) because there are no per-element host calls.

## `SharedStore.batch` — coalesced writes

```ts
store.batch(() => {
  store.setIn('doc', ['a'], 1);
  store.setIn('doc', ['b'], 2);
  store.setIn('doc', ['c'], 3);
}); // writes apply immediately (reads stay consistent); watchers fire ONCE
```

Inside `batch(fn)`, writes apply immediately (so reads within the batch are
consistent) but change notifications are **deferred and coalesced** — one
whole-key notification per changed key when the batch ends. `batchBegin()` /
`batchEnd()` are the manual bracket the reactive-state layer uses to coalesce a
whole microtask's writes.

## Lifetime & ownership

All three primitives are opened **by name** from a process-global registry. The
name is the identity: opening `'session'` in the host and three workers yields
four handles onto one thing.

**Nothing owns the data except the process.** That is forced by the requirement —
it has to outlive any single runtime or two workers could never meet on it. It
follows that the data survives the worker that created it *and* a JS reload
(dev reloads rebuild JS without restarting the process).

### Refcounting

The registries hold **`std::weak_ptr`**, not owning references. The data is freed
when the last handle in any runtime drops:

```cpp
// SharedValue.cpp
std::unordered_map<std::string, std::weak_ptr<SVCell>> registry;
// openCell: it->second.lock() — a name with no live handles is a miss
```

`sweepExpiredLocked` prunes dead entries, but only past a small threshold (32) so
the common case pays nothing.

This was a deliberate change from the original design, where the registries held
owning references and every name ever opened lived until process death. That is
fine for a handful of app-global names and a leak for anything dynamic (per
session, per document, per screen).

**Release is eventual, not scope-bound.** The last reference is held by a JS host
object, so the data is freed when Hermes collects it — leaving scope only makes
it eligible. That is why `delete(name)` exists for callers who need a known
moment, and why the in-app suite needs `__rnworkersCollectGarbage()`
(`jsi::instrumentation`) to test the refcount behaviour deterministically.

### `delete(name)` — deterministic release

Each primitive exposes a `static delete(name)` for callers who want release *now*
rather than eventually. It **detaches the name**; it does not invalidate live
handles:

- Handles opened before the delete keep working, against an orphan nothing else
  can reach.
- The next open of that name creates a **fresh** instance. The two do not observe
  each other.
- `SharedStore` subscribers are **not** unsubscribed — they just stop hearing
  from anyone.
- `SharedBuffer` re-opens allocate fresh memory whose `byteLength` is fixed by the
  new first opener; previously handed-out `ArrayBuffer`s keep their own bytes
  alive.

So `delete` is for "this name is finished with everywhere, including in workers",
not for resetting a value still in use. To reset, write to it.

### The lock lives inside the memory

`SharedBuffer`'s cross-runtime mutex is a member of `SharedMem` rather than
sitting in its own registry, and `openLock` hands out a `shared_ptr` built with
the **aliasing constructor**:

```cpp
return std::shared_ptr<std::recursive_mutex>(mem, &mem->mutex);
```

That gives the lock exactly the buffer's identity and lifetime. A separate lock
registry could outlive its buffer, or — worse — a re-opened name could get a
*different* lock than a handle still using the old memory, which is a silent
correctness bug rather than a leak.

### Consequences for callers

Two failure modes fall out of the name model, both worth documenting for users:

1. **Stale state across reloads.** A fixed name inherits the previous run's data
   *and* any subscribers belonging to workers that no longer exist. Scope names
   to whatever owns the data (`'notes-' + mountId`).
2. **No history.** A write with no subscriber is applied and observed by nobody;
   nothing replays it. Since a worker is not subscribed until its code has
   evaluated, producers must wait for an awaited "attach" call rather than
   writing straight after `new Worker(...)`.

## `reactive` / `defineModule` state

`reactive(store)` wraps a `SharedStore` key as a normal-looking object (property
reads → lazy `getIn`, writes → `setIn`, arrays → mutators), with per-tick batched
writes. It's what backs `defineModule`'s `state` facet — see
[`docs/jsmodule-defineModule.md`](./jsmodule-defineModule.md). Use it for
structured, watchable app state; drop to `SharedValue`/`SharedBuffer` for the hot
numeric paths.

## Choosing

- A few hot scalars, read/written every frame → **`SharedValue`**.
- Bulk numeric arrays / per-frame math → **`SharedBuffer`** (+ a lock or
  single-writer).
- Structured, watchable, granularly-patched app state → **`SharedStore`** /
  `reactive` / `defineModule.state`.
- Discrete request/response or events → **JSModule bridge** (async).
- Fire-and-forget data handoff → **`postMessage`**.
