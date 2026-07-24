---
sidebar_position: 5
title: UIWorker (main-thread worker)
---

# `UIWorker` — a worker on the UI thread

A `UIWorker` is a worker whose JavaScript runtime runs on the platform **UI/main
thread** instead of a background thread. It has the exact same API as `Worker`.

```js
import { UIWorker } from '@ammarahmed/react-native-workers';

const w = new UIWorker({
  inline: `self.onmessage = (e) => self.postMessage({ uiEcho: e.data });`,
});
w.onmessage = (e) => console.log(e.data); // { uiEcho: 42 }
w.postMessage(42);
```

## When to use it

Use a `UIWorker` when the worker's code must touch **UI-thread-only** capabilities
synchronously — for example UI-affine native modules that are denylisted in a
normal (background) worker. Because it runs on the main thread, there's no thread
hop for those calls.

## When **not** to use it

A `UIWorker` shares the main thread with rendering. **Heavy work here janks your
UI** — that's the opposite of what a background `Worker` is for. Keep `UIWorker`
code small and non-blocking; put compute in a regular `Worker`.

:::tip
If your goal is "run fast per-frame logic on the UI thread and read/write shared
values" (the Reanimated worklet use case), pair a `UIWorker` with
[`SharedValue`](../shared-data/shared-value) and
[`SharedBuffer`](../shared-data/shared-buffer) — synchronous shared data with no
thread hop.
:::

## Shared, persistent runtimes

A background `Worker` is one-to-one with its runtime: `new Worker(...)` spins up a
runtime and `terminate()` reaps it. A `UIWorker` is different by default:

> **UIWorker runtimes are shared and persistent, keyed by source URL.**

- The **first** `new UIWorker('./ui-work')` evaluates the script and creates a
  runtime on the main thread.
- Every **later** `new UIWorker('./ui-work')` — anywhere in your app — attaches a
  new *handle* to that **same** runtime. The script is **not** re-evaluated.
- The runtime lives for the **life of the process**. `terminate()` only
  disconnects the calling handle; it never reaps a shared runtime.

This exists for correctness, not just convenience. A `UIWorker` often installs
things that outlive any one screen — a native registration, a singleton, a
metadata table. If each `new UIWorker()` rebuilt the runtime and `terminate()`
tore it down, navigating to a screen, away, and back would re-run all of that (or
crash, if the thing it registered can't be registered twice). With a persistent
runtime, the natural React pattern just works:

```js
useEffect(() => {
  const w = new UIWorker('./ui-work', { nativeModules: true });
  // ...use w...
  return () => w.terminate(); // disconnects this handle only
}, []);
```

First visit builds and loads the runtime; every later visit **reconnects**
instantly. Modules the worker registered are re-announced to the reconnecting
handle, so [`ready()`](../rpc/jsmodule-bridge) resolves without the script
running again.

### `terminate()` vs `terminateRuntime()`

| Call | Shared `UIWorker` (default) | `independent` `UIWorker` / `Worker` |
| --- | --- | --- |
| `terminate()` | Disconnects **this handle**. Runtime and other handles keep running. | Reaps the runtime. |
| `terminateRuntime()` | Reaps the **backing runtime** — joins its thread, drops every handle on it, and clears it from the registry so a later `new UIWorker(sameUrl)` builds a fresh one. | Same as `terminate()`. |

```js
w.terminate();          // leave; runtime persists for the next screen
w.terminateRuntime();   // actually stop the runtime (all handles)

// Tear down by URL without holding a handle:
UIWorker.terminateRuntime('./ui-work');
```

`terminateRuntime()` is the explicit kill switch — the persistent default
deliberately never reaps on its own.

### Opting out: `independent`

Pass `{ independent: true }` to get the background-`Worker` model back: a fresh
**private** runtime per `new UIWorker()`, evaluated every time, reaped by
`terminate()`.

```js
const w = new UIWorker('./ui-work', { independent: true });
// own runtime; terminate() reaps it.
```

Reach for it when you genuinely want an isolated, disposable main-thread runtime
rather than a shared long-lived one.

:::warning[Recreating a runtime that registers with React Native]
If your `UIWorker` **permanently registers something with React Native** — for
example a view manager via `RCTRegisterModule` — do **not** use `independent` or
`terminateRuntime()` for it. RN can't unregister such a class, so a second
runtime that registers again collides, and the old registration keeps pointing at
the reaped runtime. The shared, persistent default is exactly what makes that
pattern safe: it registers **once** and never tears down. `independent` /
`terminateRuntime()` are for workers that only *use* native APIs (imperative
UIKit, computation), not ones that install permanent registrations.
:::

## Debugging

By default a `UIWorker` is **not** a separate DevTools target — its `console.*` is
forwarded to the host (tagged `[Worker:<name>]`) and uncaught errors reach
`onerror`, which is the recommended way to debug it.

You can opt into a real target with `{ inspectable: true }`, but be warned: a
`UIWorker` runs on the main thread, so **pausing at a breakpoint freezes the whole
app** (and the OS may kill it). Use it only for short, deliberate sessions. See
[Debugging workers → UIWorker](./debugging#uiworker) for the full rationale.

## Platform support

`UIWorker` is fully supported on **both iOS and Android**. The runtime, its
timers, and its message/`CallInvoker` dispatch all run on the platform main
thread:

- **iOS** — driven by `dispatch_get_main_queue`.
- **Android** — driven by a `Handler` bound to the main `Looper`.

A background `Worker` also works on both platforms.
