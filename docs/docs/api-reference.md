---
sidebar_position: 7
title: API reference
---

# API reference

A consolidated reference for everything exported from
`@ammarahmed/react-native-workers`. Follow the links for guides and examples.

## `Worker`

```ts
new Worker(source: string | { inline: string }, options?: WorkerOptions)
```

`source` is normally a **relative path to a worker file** (`'./workers/task'`),
compiled into its own bundle by the [Babel plugin](./installation#3-add-the-babel-plugin)
— the primary way to create workers. `{ inline: '…code…' }` runs a source string
directly and is meant for small snippets.

| Member | Type | Description |
| --- | --- | --- |
| `postMessage(data, transfer?)` | `(any, any[]) => void` | Send a message to the worker |
| `onmessage` | `(e: MessageEvent) => void` | Incoming messages |
| `onerror` | `(e: ErrorEvent) => void` | Uncaught worker errors |
| `addEventListener(type, cb)` / `removeEventListener` | | `'message'` / `'error'` |
| `terminate()` | `() => void` | Stop the worker and free its thread |
| `module<T>(name)` | → `Remote<T>` | Typed proxy to a worker module — [bridge](./rpc/jsmodule-bridge) |
| `registerModule(name, impl)` | → `ModuleHandle` | Expose a host module |
| `ready(name, timeoutMs?)` | → `Promise<void>` | Resolve when a worker module registers |

```ts
interface WorkerOptions {
  name?: string;
  maxHeapMb?: number;      // default 256
  nativeModules?: boolean; // default false — opt into platform TurboModules
  independent?: boolean;   // UIWorker only — private runtime instead of shared
  inspectable?: boolean;   // UIWorker only, dev only — register a DevTools target (freezes UI on pause)
}
```

See [Creating workers](./guides/creating-workers).

## `WorkerTerminatedError`

```ts
class WorkerTerminatedError extends Error {
  name: 'WorkerTerminatedError';
  code: 'ERR_WORKER_TERMINATED';
}
```

Rejects calls and `ready()` waiters that were still in flight when the worker was
terminated. See [Termination](./rpc/jsmodule-bridge#termination).

## `UIWorker`

Same API as `Worker`, but the runtime runs on the platform UI/main thread.
Supported on both iOS and Android.

By default UIWorker runtimes are **shared and persistent**, keyed by source URL:
a second `new UIWorker(sameUrl)` reconnects to the already-loaded runtime, and
`terminate()` only disconnects the handle. Pass `{ independent: true }` for a
private, disposable runtime.

| Member | Type | Description |
| --- | --- | --- |
| `terminate()` | `() => void` | Disconnect this handle (shared) / reap the runtime (`independent`) |
| `terminateRuntime()` | `() => void` | Reap the backing runtime and every handle on it; clears it from the registry |
| `static UIWorker.terminateRuntime(source)` | `(WorkerSourceInput) => void` | Reap the shared runtime for a source by URL, without a handle |

See [UIWorker](./guides/ui-worker) for the shared-runtime model and when to use
`independent` / `terminateRuntime()`.

## `SharedStore`

```ts
new SharedStore(name?: string) // default name: 'default'
```

| Method | Description |
| --- | --- |
| `get(key)` / `getIn(key, path)` | Lazy read / read nested |
| `set(key, value)` / `setIn(key, path, value)` | Replace / patch nested |
| `merge(key, partial)` | Deep-merge an object |
| `deleteIn(key, path)` | Remove nested (arrays splice) |
| `has(key)` / `delete(key)` / `keys()` | Presence / remove / list |
| `subscribe(key, cb)` | Watch a key → unsubscribe fn |
| `subscribeIn(key, path, cb)` | Watch a sub-path (delta) → unsubscribe fn |
| `watch(cb)` | Watch all keys → unsubscribe fn |
| `batch(fn)` | Coalesce writes into one notification |
| `static delete(name)` | Detach a named store process-wide → `boolean` |

See [SharedStore](./shared-data/shared-store).

## `SharedValue`

```ts
new SharedValue<T = number>(name: string, initial?: T)
```

| Member | Description |
| --- | --- |
| `.value` (get/set) | Synchronous read/write (lock-free for numbers) |
| `.subscribe(cb)` | Observe changes → unsubscribe fn |
| `static delete(name)` | Detach a named cell process-wide → `boolean` |

See [SharedValue](./shared-data/shared-value).

## `SharedBuffer`

```ts
new SharedBuffer(name: string, byteLength: number)
```

| Member | Description |
| --- | --- |
| `.arrayBuffer` | `ArrayBuffer` over shared memory |
| `.byteLength` | Size in bytes |
| `.withLock(fn)` | Run `fn` under the buffer's cross-runtime lock |
| `static delete(name)` | Detach a named buffer process-wide → `boolean` |

See [SharedBuffer](./shared-data/shared-buffer).

All three are named and process-global, and their memory is reference-counted —
see [Names & lifetime](./shared-data/lifetime) for what `delete` does and does
not do.

## `reactive`

```ts
reactive<T>(store: SharedStore, rootKey?: string): T
```

Wrap a store key as a plain-looking, batched reactive object. See
[Reactive state](./shared-data/reactive-state).

## `defineModule`

```ts
defineModule<C extends ModuleContract>(name: string): Module<C>
```

Returns `{ worker(impl), host(worker, impl), watch(state, selectorOrPath, cb) }`.
See [defineModule](./rpc/define-module).

## `nativeWorkerSelfTest`

```ts
nativeWorkerSelfTest(): Promise<string>
```

Runs the C++-created worker self-test — useful to verify the native side is wired.

## Worker-side globals

Available inside every worker (no import):

| Global | Description |
| --- | --- |
| `self`, `postMessage`, `onmessage`, `close`, `addEventListener` | Web Worker surface |
| `setTimeout` / `setInterval` / `queueMicrotask` | Timers |
| `structuredClone` | Structured clone |
| `Worker` | Nested workers |
| `SharedStore`, `SharedValue`, `SharedBuffer` | Shared data |
| `JSModule`, `parent`, `defineModule`, `reactive` | RPC + reactive state |
| `NativeEventEmitter` | Native events |
| `__rnworkersGetModule(name)` | Convenience native-module accessor |
