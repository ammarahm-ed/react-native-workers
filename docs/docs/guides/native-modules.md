---
sidebar_position: 3
title: Native modules in workers
---

# Native modules in workers

A worker can call native modules — C++ (Cxx) modules, platform
(Java/Kotlin/Objective-C) TurboModules, and legacy (old-architecture) modules
through RN's interop layer — so background work can reach storage, crypto, the
filesystem, and more, without hopping back to the JS thread.

Import the library the same way you would in your app and call its normal
JS API. A handful of modules that are inherently tied to the UI thread are
[denylisted](#whats-not-allowed).

## Two tiers

| | Works by default | Cost |
| --- | --- | --- |
| **C++ (Cxx) TurboModules** + nested workers | ✅ yes | negligible |
| **Platform modules** (Java/ObjC TurboModules *and* legacy modules) | opt-in per worker | a per-worker manager (memory + teardown) |

C++ modules are available in every worker with no setup. Platform modules are
**opt-in** because building a per-worker TurboModule manager costs memory and must
be torn down with the worker.

## Using a library inside a worker

Import the library **the same way you would in your app** and call its
high-level API — you don't touch the raw TurboModule. Here a worker uses
[`react-native-blob-util`](https://github.com/RonRadtke/react-native-blob-util)
(a TurboModule) to do filesystem work off the JS thread:

```ts title="workers/blobutil.ts"
import ReactNativeBlobUtil from 'react-native-blob-util';

self.onmessage = async () => {
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/from-worker.txt`;
  await ReactNativeBlobUtil.fs.writeFile(path, 'hello from a worker', 'utf8');
  const text = await ReactNativeBlobUtil.fs.readFile(path, 'utf8');
  await ReactNativeBlobUtil.fs.unlink(path);
  self.postMessage({ text });
};
```

```ts title="App.tsx"
// Opt in to platform modules with { nativeModules: true }.
const worker = new Worker('./workers/blobutil', { nativeModules: true });
worker.onmessage = (e) => console.log(e.data.text); // "hello from a worker"
worker.postMessage('go');
```

The library's JS wrapper resolves the underlying module through
`TurboModuleRegistry` / `NativeModules` exactly as it does in your app —
including things like `NativeEventEmitter` — so its normal API just works.

Legacy (old-architecture) libraries work the same way. This worker uses
[`react-native-gzip`](https://github.com/ammarahm-ed/react-native-gzip), a plain
`ReactContextBaseJavaModule`:

```ts title="workers/gzip.ts"
import { deflate, inflate } from 'react-native-gzip';

self.onmessage = async (e) => {
  const base64 = await deflate(e.data);
  self.postMessage({ base64, roundTrips: (await inflate(base64)) === e.data });
};
```

### Low-level access

If you need the raw module (no wrapper), resolve it with `TurboModuleRegistry`
or, in an inline worker, the `__rnworkersGetModule(name)` convenience accessor:

```js
const worker = new Worker(
  {
    inline: `
      self.onmessage = () => {
        const mod = globalThis.__rnworkersGetModule('SourceCode');
        self.postMessage(mod ? mod.getConstants().scriptURL : null);
      };
    `,
  },
  { nativeModules: true },
);
```

## iOS — no setup

On iOS a per-worker `RCTTurboModuleManager` resolves **any** registered
Objective-C module through the process-global registry. Nothing to configure.

## Android — register your packages once

Android has no global native-module registry, so the worker needs to know which
`ReactPackage`s to build a delegate from. Register them once when the React context
is ready:

```kotlin title="MainApplication.kt"
reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener {
  override fun onReactContextInitialized(context: ReactContext) {
    if (context is ReactApplicationContext) {
      WorkerTurboModules.initialize(
        context,
        PackageList(this@MainApplication).packages, // the packages workers may use
      )
    }
  }
})
```

RN's **core** modules (`SourceCode`, `PlatformConstants`, `DeviceInfo`, …) are
added automatically — you don't list them. Without `initialize`, `nativeModules`
workers fall back to C++ modules only.

## What's not allowed

**UI-affine modules are denylisted** in workers — `UIManager`, `FabricUIManager`,
`SurfaceRegistry`, `AccessibilityInfo` and `DeviceEventManager` touch the view
hierarchy, which only exists on the UI thread. `TurboModuleRegistry.get` returns
`null` for them. If you need to run JS on the UI thread to reach those, use a
[`UIWorker`](./ui-worker) instead.

Denial happens when the worker's module registry is built, so a denied module is
never *constructed* in a worker — not merely hidden from lookups.

## Blob support

`Blob` (and everything built on it — `URL.createObjectURL`, blob-backed `fetch`
and `XMLHttpRequest`, WebSocket sends) works inside workers. Blob storage is
shared with the host, so a blob created in a worker resolves on the host
and vice versa.

`Blob` is not a worker global, because workers deliberately skip RN's
`InitializeCore`. Import it directly:

```ts
import Blob from 'react-native/Libraries/Blob/Blob';

const blob = new Blob(['hello ', 'from a worker'], { type: 'text/plain' });
```

:::note[Android internals]
On Android, workers are served a purpose-built replacement for RN's `BlobModule`.
RN's own implementation cannot run in a worker: its `initialize()` installs a
blob-collector callback onto the **host** runtime while capturing a JNI
reference, which the host's garbage-collector thread later releases without being
attached to the JVM — aborting the process. The replacement delegates all storage
to the host's real `BlobModule` and installs a per-worker collector that holds no
JNI reference at all, so it is safe to finalize on any thread.

This requires React Native's `useTurboModuleInterop` flag, which is on by default
under bridgeless. With it disabled, workers simply have no `BlobModule` and
`Blob` is unavailable — use [`SharedBuffer`](../shared-data/shared-buffer) for
binary data instead.
:::

## JSI libraries

Libraries that install JSI bindings directly — rather than exposing TurboModule
methods — work in workers too, and install into the **worker's own runtime**:

```ts title="workers/storage.ts"
import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'worker' });
storage.set('key', 'value');
```

Both [`react-native-mmkv`](https://github.com/mrousavy/react-native-mmkv)
(Nitro-based) and
[`react-native-mmkv-storage`](https://github.com/ammarahm-ed/react-native-mmkv-storage)
are covered by the example app's test suite.

This needs no cooperation from the library. The common install idiom is:

```kotlin
val jsContext = context.javaScriptContextHolder
install(jsContext.get(), context.jsCallInvokerHolder)
```

which asks the **React context** for "the" JS runtime — an assumption that holds
only while an app has exactly one. Given the host context, a worker would install
its bindings onto the host's global and then fail its own `isLoaded()` check.

So each worker's module registry is built with a `ReactApplicationContext` whose
`javaScriptContextHolder` and `jsCallInvokerHolder` report *that worker's* runtime
and CallInvoker. Everything else on the context is delegated to the host, so
modules still see the app's real activity, lifecycle and message queues.

:::caution[Thread safety]
Bindings installed this way run on the **worker's** JS thread, and the library's
native state is usually shared process-wide. A library that assumes it is only
ever touched from one JS thread may need its own locking. Storage engines like
MMKV are designed for concurrent access; not every library is.
:::

## Native events

Modules that emit device events work too — see
[Native events (`NativeEventEmitter`)](./native-events).

## Isolation rules

Two rules are enforced, and they are the difference between "native modules load in
a worker" and "native modules are actually useful in a worker":

1. **A worker never blocks the host runtime or the RN JS thread.**
2. **A worker's native modules stay on that worker** — its own events, its own
   module instances.

What that means in practice:

- **Events raised by a worker's modules never reach the host runtime.** They are
  delivered directly into the worker that owns the module. Earlier versions
  dispatched them on the host runtime and copied them back out, which meant a
  worker's HTTP response depended on the RN JS thread being free.
- **Module method bodies do not run on the worker's JS thread.** On Android each
  worker has its own native-modules queue thread, mirroring what RN does on the
  host, so a module doing blocking work doesn't stall that worker's event loop.
- **Peer lookups resolve within the worker.** A module asking the context for
  another module gets that worker's instance, not the host's.

Both rules are covered by tests that fail if they regress — including one that pins
the host JS thread in a busy loop and requires a worker's network request to
complete anyway.

:::caution[What isolation does *not* give you]
None of this makes a module that assumes a single runtime on a single thread safe
to use from two. A worker gets its own instance where the module's design allows
it, but a module holding process-wide mutable state without a lock is still a
hazard — see the note on thread-safety above. This is why platform modules are
opt-in per worker rather than on by default.

These guarantees also rest on private React Native internals that move between
versions. [Hacks & compatibility seams](/docs/compat-seams) lists exactly which
ones and what would let me stop depending on them.
:::

## How it works (short version)

- **C++ modules** resolve from the process-global CxxTurboModule map, bound to the
  worker's CallInvoker.
- **iOS platform modules**: a generic delegate returns `nil`, so the manager
  resolves any class from `RCTGetModuleClasses()`.
- **Android platform modules**: C++ builds worker-bound
  `CallInvokerHolder`/`RuntimeExecutor` holders and calls into a Kotlin bridge that
  builds a `TurboModuleManager` from your packages; the whole worker thread runs
  under the app classloader so JNI resolves your classes. The denylist is applied
  to that package list, and worker-safe replacements (such as the blob module) are
  appended to it. The registry is built **per worker**, against a
  `ReactApplicationContext` reporting that worker's runtime, device-event target,
  and native-modules queue — see [JSI libraries](#jsi-libraries).

On Android, method bodies run on the worker's **own native-modules queue thread**,
not on its JS thread — so `assertOnNativeModulesQueueThread()` and
`runOnNativeModulesQueueThread()` inside a worker refer to that worker's queue. On
iOS they run on the invoker RN gives the module, as on the host.

The manager is invalidated **before** the worker runtime is destroyed, so there's
no leak, and teardown is ordered so a module's own cleanup work (which modules
legitimately hand to the native queue) still runs.

Creating and tearing down workers that use native modules is exercised on every
release: repeated create → call → terminate cycles with both a TurboModule
(`react-native-blob-util`) and a legacy module (`react-native-gzip`) run with zero
crashes.
