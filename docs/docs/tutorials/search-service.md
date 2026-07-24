---
sidebar_position: 1
title: 1. Search service (typed RPC)
---

# Building the search service

**What you’ll build:** a worker that owns a 2000-document corpus and an
inverted index. The host types a query and gets ranked results back. The worker
fetches its data *from the host*, and streams progress events while indexing.

**Why start here:** this is the shape most apps want first — the worker owns
expensive state, the host asks it questions. Nothing large crosses between
runtimes.

Files: `example/src/workers/search.ts` · `example/src/screens/SearchServiceScreen.tsx`

## Step 1: decide what lives where

Before writing anything, decide who owns the data. That decision drives
everything else.

- The **corpus** and the **index** live in the worker. They are large and only
  the worker touches them.
- The **query** and the **handful of results** cross the boundary. They are tiny.

The wrong version of this example would send the corpus to the worker on every
search, or send the whole index back. Keep the big thing still and move the small
thing.

## Step 2: register a module in the worker

A worker exposes an API by registering a **JSModule**. Inside a worker, `parent`
is the host:

```ts
// workers/search.ts
declare const parent: any;

const mod = parent.register('search', {
  search(query: string) {
    return { hits: [], ms: 0 };
  },
});
```

`parent.register(name, impl)` returns a handle with `.emit()` on it, used in
step 5. `new JSModule('search', impl)` does exactly the same thing; `register` is
preferred here because a constructor called purely for a side effect reads like a
mistake.

Every method becomes async from the host's point of view, whether or not you
declare it `async`. Return a value, return a promise — the host awaits either.

## Step 3: call it from the host

```tsx
// screens/SearchServiceScreen.tsx
const w = new Worker('../workers/search');
const search: any = w.module('search');

const res = await search.search('worker');
```

`w.module(name)` is a proxy — every property access becomes a remote call. It
does not check that the module exists, so a typo is a call that never resolves
(until it times out at 15s).

:::caution[Worker paths are relative to the file]
`'../workers/search'` is resolved relative to **the file doing the importing**,
not the project root. This screen lives in `src/screens/`, so the worker is
`../workers/search`. Moving the screen breaks the path.
:::

## Step 4: let the worker call back into the host

The bridge is **two-way**. The host registers a module the *worker* calls:

```tsx
// host
w.registerModule('app', {
  fetchDocs() {
    return makeDocs(2000); // the "backend" — a network call in a real app
  },
  log(message: string) {
    logEvent(`worker → host: ${message}`);
  },
});
```

```ts
// worker
const docs = await parent.module('app').fetchDocs();
```

Now the worker pulls its own data when it is ready, instead of the host guessing
when to push it. This is how you give a worker access to something only the host
has — a token, the network stack, a native module the worker can't reach.

## Step 5: stream progress with events

A call gives you one answer at the end. Indexing 2000 documents takes long enough
that the UI should show progress, so the worker **emits** while it works:

```ts
// worker — `mod` is what parent.register returned
for (let i = 0; i < docs.length; i++) {
  // ...index doc...
  if (i % 250 === 0) {
    mod.emit('progress', { done: i, total: docs.length });
  }
}
```

```tsx
// host
search.$on('progress', (p: any) => setProgress(p));
```

`$on` returns an unsubscribe function. Events are one-way and fire-and-forget —
there is no reply and no backpressure, so don't emit per item in a tight loop.
Every 250 documents is plenty for a progress bar.

## Step 6: gate on readiness

`new Worker(...)` returns immediately; the worker's code has not run yet. Calls
made before the module registers are **queued**, not lost — but if you want to
know when the worker is genuinely up (to hide a spinner, or before doing
something order-sensitive), wait for it:

```tsx
await w.ready('search', 5000);
const built = await search.build();
```

`ready` rejects after its timeout so a worker that failed to load surfaces as an
error instead of hanging forever.

## Step 7: tear down

```tsx
useEffect(() => {
  const w = new Worker('../workers/search');
  // ...
  return () => w.terminate();
}, []);
```

`terminate()` destroys the runtime. Calls still in flight reject with
`WorkerTerminatedError` (`code === 'ERR_WORKER_TERMINATED'`) — expected during
teardown, and calls you never awaited will not produce an unhandled-rejection
warning. See [Termination](../rpc/jsmodule-bridge#termination).

## What to take away

- Put the big data where the work is; move only queries and results.
- `registerModule` on the host is what makes the bridge two-way — use it to give
  the worker access to things only the host has.
- Use events for progress, calls for answers.
- Worker source paths are relative to the importing file.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=search yarn start --reset-cache
```

Change the corpus size in `makeDocs(2000)` and watch the indexing time and the
progress events change. Try removing the `await w.ready(...)` to see that calls
still work — they queue.

Next: [Note editor (SharedStore)](./note-editor) →
