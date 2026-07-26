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
| `onmessageerror` | `(e: MessageEvent) => void` | A message that could not be deserialized |
| `addEventListener(type, cb)` / `removeEventListener` | | `'message'` / `'error'` / `'messageerror'` |
| `dispatchEvent(event)` | `(any) => boolean` | Fire an event at this handle locally |
| `terminate()` | `() => void` | Stop the worker and free its thread |
| `module<T>(name)` | → `Remote<T>` | Typed proxy to a worker module — [bridge](./rpc/jsmodule-bridge) |
| `registerModule(name, impl)` | → `ModuleHandle` | Expose a host module |
| `ready(name, timeoutMs?)` | → `Promise<void>` | Resolve when a worker module registers |

```ts
interface WorkerOptions {
  name?: string;
  maxHeapMb?: number;      // see the note below — not currently applied
  nativeModules?: boolean; // default false — opt into platform TurboModules
  independent?: boolean;   // UIWorker only — private runtime instead of shared
  inspectable?: boolean;   // UIWorker only, dev only — register a DevTools target (freezes UI on pause)
}
```

:::caution[`maxHeapMb` is not wired up yet]
The option is accepted by the type but **is not forwarded to the native layer**,
so setting it has no effect today — every worker runtime is created with the
256 MB Hermes heap default. Don't rely on it to raise or lower a worker's cap.
:::

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
| `batchBegin()` / `batchEnd()` | The same, opened and closed manually |
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
reactive<T>(store: SharedStore, rootKey?: string): T // rootKey defaults to 'state'
```

Wrap a store key as a plain-looking, batched reactive object. The store argument
is **required** — `reactive()` always sits on top of a `SharedStore`. See
[Reactive state](./shared-data/reactive-state).

## `defineModule`

```ts
defineModule<C extends ModuleContract>(name: string): Module<C>
```

Returns `{ worker(impl), host(worker, impl), watch(state, selectorOrPath, cb) }`.
See [defineModule](./rpc/define-module).

## `Thread` (experimental, worker-side)

Runs this worker's *own* runtime on another thread for the duration of a
callback — no second runtime, nothing serialized. It is a **worker global**, not
an import, and every entry point throws until the worker opts in.

```js
enableMultiThreadingExperimental();

const codec = Thread.create('codec');
await codec.run(() => decodeFrame(bytes));   // on the 'codec' thread
await Thread.main.run(() => paintNative());  // on the main/UI thread
```

| Member | Description |
| --- | --- |
| `enableMultiThreadingExperimental()` | Opt in, per worker. Everything below throws until it is called |
| `Thread.create(name?)` | → `WorkerThread` — a fresh serial background thread |
| `Thread.main` | The platform main/UI thread |
| `Thread.current` | Name of the thread currently executing; `''` on the worker's own thread |
| `thread.run(fn)` | → `Promise<T>` — run `fn` on that thread; settles back on the worker's own thread |
| `thread.dispose()` | → `boolean` — stop the thread (throws for `Thread.main`) |
| `thread.disposed` / `thread.name` | State and label |

The package exports the **types** for these globals (there is nothing to import
at runtime):

```ts
import type { ThreadApi, WorkerThread } from '@ammarahmed/react-native-workers';

declare const Thread: ThreadApi;
declare function enableMultiThreadingExperimental(): boolean;
```

See [Thread hopping](./guides/threads) for the rules — it buys thread affinity,
not parallelism.

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
| `MessageEvent`, `ErrorEvent` | Event constructors |
| `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` | Timers |
| `setImmediate` / `clearImmediate` / `queueMicrotask` | Immediate + microtask scheduling |
| `structuredClone` | Structured clone |
| `console` | Forwarded to the host logs, tagged `[Worker:<name>]` |
| `location` | The worker's own source URL |
| `importScripts(url)` | Classic Web Worker script loading |
| `Worker` | Nested workers |
| `SharedStore`, `SharedValue`, `SharedBuffer` | Shared data |
| `JSModule`, `parent`, `defineModule`, `reactive` | RPC + reactive state |
| `NativeEventEmitter` | Native events |
| `Thread`, `enableMultiThreadingExperimental()` | [Thread hopping](./guides/threads) — experimental, opt-in |
| `requireNativeModule(name)` | Expo apps only, with `nativeModules: true` — see [Expo modules in a worker](./installation#expo-modules-inside-a-worker) |
| `__rnworkersGetModule(name)` | Convenience native-module accessor |

## Exported types

```ts
import type {
  WorkerOptions, WorkerSourceInput, WorkerRef,   // Worker
  ThreadApi, WorkerThread,                       // Thread (worker globals)
  StoreListener, Unsubscribe,                    // SharedStore
  ModuleContract, Module, WorkerSide, HostSide,  // defineModule
  Remote, RemoteExtras, JSModuleImpl, ModuleHandle, BridgeEndpoint, // bridge
} from '@ammarahmed/react-native-workers';
```
