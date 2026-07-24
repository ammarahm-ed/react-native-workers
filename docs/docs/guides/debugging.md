---
sidebar_position: 7
title: Debugging workers
---

# Debugging workers

A worker is a real Hermes runtime, and it debugs like one. Each background worker
registers itself as **its own DevTools target** — you get breakpoints, stepping,
a scope inspector, and its own console, exactly as you would for the main app
runtime. On top of that, everything a worker logs is mirrored to the host so it
shows up wherever your app logs already go.

## Each worker is its own target

When a background `Worker` starts, it publishes its runtime to the React Native
inspector (Fusebox) as a separate page, **before any of your worker code runs** —
so a breakpoint on the first line of a worker is honoured. In the debugger's
target list it appears as:

```
Worker: <name>
```

The name is the worker's `name` option, or its source-file stem if you didn't set
one (`Worker: search`), so several concurrent workers stay tellable apart instead
of all showing up as "Worker".

### Opening it

1. Run a **debug** build (the inspector is compiled out of release — see below).
2. Open **React Native DevTools**: press `j` in the Metro terminal, or "Open
   DevTools" from the Dev Menu.
3. In the target/dropdown list you'll see your app's main runtime **and** a
   `Worker: <name>` entry for each live worker. Select the worker to debug it.

Inside that target you can:

- set breakpoints in worker source and step through it,
- inspect scope, call stack, and evaluate in the worker's context from the
  console,
- read the worker's own bundle sources (the worker serves them over CDP).

A worker target **survives a JS reload of the host** — reloading the app doesn't
drop your worker debug session.

:::tip[Set a `name`]
Always pass `{ name: 'indexer' }` (or similar) when you create a worker you plan
to debug. It becomes the target label and the console tag, which matters the
moment you have more than one worker.
:::

## Console forwarding

Inside a worker, `console.log` / `info` / `warn` / `error` / `debug` go to **two**
places:

1. **The worker's own DevTools console** — the untouched call, so objects are
   inspectable in the worker target.
2. **The host**, as a tagged copy, so worker output lands next to your app logs
   (Metro, the host DevTools console):

   ```
   [Worker:search] indexed 2000 docs in 67ms
   ```

The tag is `[Worker:<name>]` (falling back to the worker id). `Error` values are
formatted with their stack rather than the useless `{}` you'd get from
`JSON.stringify`, so `console.error(err)` inside a worker is actually readable on
the host.

Because logs are forwarded, you can debug a worker with nothing but `console.log`
and never open the worker target at all — useful in CI or on a device.

## Uncaught errors

An uncaught error (or unhandled rejection) inside a worker is delivered to the
host as the worker's `onerror`, rebuilt into a real `Error` with the original
**worker-side stack**:

```js
const worker = new Worker('./risky');
worker.onerror = (e) => {
  console.log(e.message, e.error?.stack); // stack points into worker code
};
```

The original `Error` object can't cross the runtime boundary, so the library
reconstructs one on the host with `message` and `stack` preserved — without this
`e.error?.stack` would always be `undefined`.

Bridge calls (`module().foo()`) and `ready()` waiters that were still in flight
when a worker is terminated reject with
[`WorkerTerminatedError`](../rpc/jsmodule-bridge#termination) (`code:
'ERR_WORKER_TERMINATED'`), so you can tell "the worker went away" apart from a
real failure.

## Release builds

Target registration is gated on the inspector being enabled (Fusebox), which is a
**dev-only** flag. In a release build no `CDPDebugAPI` is created and no target is
published — there is zero debug cost in production. Console forwarding to the host
still happens (it's cheap), so shipped diagnostics keep working.

## UIWorker

A [`UIWorker`](./ui-worker) runs on the platform **main thread**, so by default it
is **not** registered as its own DevTools target. Its `console.*` is still
forwarded to the host (tagged `[Worker:<name>]`) and uncaught errors still surface
on `onerror` — that's the recommended way to debug one.

### `inspectable: true` — opt in, with care

You *can* register a `UIWorker` as its own target:

```js
const w = new UIWorker('./ui-work', { inspectable: true });
```

It then shows up as `UIWorker: <name>` in the target list with breakpoints,
stepping, and sources — the works.

:::danger[A UIWorker pause freezes your app]
A `UIWorker` runs on the **main/UI thread**. Hitting a breakpoint holds that
thread in the debugger until you resume — which means **the entire app UI freezes
while you're paused**, touches and rendering stop, and iOS/Android may kill the
process for being unresponsive (watchdog). This is inherent to debugging a
main-thread runtime, not a bug.

Use `inspectable: true` only for short, deliberate sessions where a frozen UI is
acceptable — e.g. stepping through a specific bug. For everyday work, prefer
forwarded `console.*` and `onerror`, which never touch the main thread. Nothing
*blocks* registering the target (it's the same Hermes CDP path background workers
use); the pause is what's hostile to the main thread.
:::

There is no cost in release: like all inspector registration, `inspectable` is a
no-op when the debugger is disabled.

If you need real breakpoints without the freeze, move the logic you're chasing
into a background `Worker` temporarily and debug it there.

## Summary

| | Background `Worker` | `UIWorker` |
| --- | --- | --- |
| Own DevTools target (breakpoints, stepping) | ✅ always | ⚠️ opt-in via `inspectable: true` — **pause freezes the app** |
| Registered before user code runs | ✅ | ✅ (when `inspectable`) |
| Survives host reload | ✅ | ✅ (when `inspectable`) |
| `console.*` forwarded to host (tagged) | ✅ | ✅ |
| Uncaught errors → host `onerror` (with stack) | ✅ | ✅ |
| Any cost in release | none | none |
