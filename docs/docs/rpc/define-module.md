---
sidebar_position: 2
title: defineModule (typed)
---

# `defineModule` — one typed contract

`defineModule` is the recommended way to talk between the host and a worker. You
declare a module's shape **once**, and each side implements its half and gets the
other side as a **fully-typed** object. Calls feel like local `async` functions;
shared state feels like a plain object.

It compiles down to the [JSModule bridge](./jsmodule-bridge) +
[reactive state](../shared-data/reactive-state), which stay available for advanced
cases.

## Define the contract once

Put the types in a file both sides import (only the types and the name survive into
each bundle):

```ts title="calc.module.ts"
import { defineModule } from '@ammarahmed/react-native-workers';

export const calc = defineModule<{
  worker: { add(a: number, b: number): number };         // methods the host calls
  host:   { getConfig(): { base: number } };              // methods the worker calls
  events: { progress: { percent: number } };              // worker → host events
  hostEvents: { cancel: { id: string } };                 // host → worker events
  state:  { status: 'idle' | 'busy'; count: number };     // shared reactive state
}>('calc');
```

Every facet is optional.

## Implement the worker half

Inside the worker, call `calc.worker(impl)`. You get back the **host** as a typed
proxy, plus `emit`, `on`, and `state`:

```ts title="calc.worker.ts"
import { calc } from './calc.module';

const { host, emit, on, state } = calc.worker({
  add: (a, b) => a + b,
});

on('cancel', ({ id }) => abort(id));   // typed host → worker event

// call the host, typed:
async function run() {
  const cfg = await host.getConfig();  // Promise<{ base: number }>
  state.count += 1;                    // shared state, reads/writes like an object
  emit('progress', { percent: 100 });  // typed event to the host
}
```

## Implement the host half

On the host, call `calc.host(worker, impl)`. You get the **worker** as a typed proxy,
plus `on`, `emit`, `state`, and `$ready`:

```ts title="screen.ts"
import { Worker } from '@ammarahmed/react-native-workers';
import { calc } from './calc.module';

const worker = new Worker('./calc.worker');
const c = calc.host(worker, {
  getConfig: () => ({ base: 100 }),
});

await c.$ready();
const sum = await c.add(2, 3);         // 5 — typed call into the worker
c.on('progress', (p) => setBar(p.percent));
c.emit('cancel', { id: 'job1' });      // typed host → worker event
console.log(c.state.status);           // shared state, read like an object
```

That's the whole thing: one definition, both sides symmetric, no string keys, no
separate interface, fully inferred.

## Events, both directions

- `events` flow **worker → host**: the worker `emit`s, the host `on`s.
- `hostEvents` flow **host → worker**: the host `emit`s, the worker `on`s.

## Shared state

The `state` facet is a [reactive object](../shared-data/reactive-state) backed by a
`SharedStore`, visible to both sides:

```ts
// worker
state.status = 'busy';
state.items.push(id);      // arrays work

// host — reads the same data
c.state.status;            // 'busy'
```

Watch a slice of it, typed by selector or explicit path:

```ts
const off = calc.watch(c.state, (s) => s.count, (count) => {
  console.log('count is now', count);
});
```

:::caution
`state` is shared, concurrent memory: writes are last-writer-wins and propagate
asynchronously; `state.count++` isn't atomic across runtimes. See
[reactive state caveats](../shared-data/reactive-state#the-honesty-caveat).
:::

## A complete example

```ts title="pipeline.module.ts"
export const pipeline = defineModule<{
  worker: { enqueue(uri: string): Promise<string> };
  host:   { resolveAsset(uri: string): Promise<ArrayBuffer> };
  events: { progress: { uri: string; percent: number } };
  state:  { queueLength: number };
}>('pipeline');
```

```ts title="pipeline.worker.ts"
const { host, emit, state } = pipeline.worker({
  enqueue: async (uri) => {
    state.queueLength = (state.queueLength ?? 0) + 1;
    const bytes = await host.resolveAsset(uri);         // ask the host
    const out = await process(bytes, (p) => emit('progress', { uri, percent: p }));
    state.queueLength -= 1;
    return out;
  },
});
```

```ts title="screen.ts"
const pipe = pipeline.host(worker, {
  resolveAsset: (uri) => FileSystem.readAsArrayBuffer(uri),
});
pipe.on('progress', ({ uri, percent }) => setBar(uri, percent));
const outUri = await pipe.enqueue(localUri);
// pipe.state.queueLength updates live
```

## Design notes

Two deliberate choices, explained at length in the design doc:

1. **Share types, not code.** The worker is a separate bundle — you share the
   `*.module.ts` type file, but each side's implementation lives in its own file. A
   single file with both implementations would drag host-only imports into the
   worker bundle.
2. **Calls stay `async`.** A call is a thread hop; making it *look* synchronous
   would either block a thread or hide a Promise you forgot to `await`. The win is
   the single typed definition, not pretending threads are free.

## Reference

| API | Where | Description |
| --- | --- | --- |
| `defineModule<C>(name)` | shared | Create the module from its contract |
| `.worker(impl)` | worker | Implement worker methods → `{ host, emit, on, state, dispose }` |
| `.host(worker, impl)` | host | Implement host methods → worker proxy + `{ on, emit, state, $ready }` |
| `.watch(state, selectorOrPath, cb)` | either | Subscribe to a slice of shared state |
