---
sidebar_position: 10
title: Examples
---

# Examples

The `example/` app in the repo is a gallery: each screen is a self-contained,
runnable demonstration of one part of the API, with the interesting numbers shown
on screen rather than asserted in a comment.

Run it, then pick a screen from the home list. To jump straight to one, set
`RN_WORKERS_SCREEN` when starting Metro:

```bash
cd example
RN_WORKERS_SCREEN=parse yarn start --reset-cache
```

Each screen's worker lives in `example/src/workers/`, and its UI in
`example/src/screens/`. Read them as a pair — the point of most of these examples
is what is *not* between the two files.

## Search service — typed RPC

`workers/search.ts` · `screens/SearchServiceScreen.tsx`

A worker owns a 2000-document corpus and an inverted index; the host sends
queries and gets typed results. Exercises the bridge in both directions: the
worker calls back into a host module to fetch its data, and streams `progress`
events while indexing.

**Shows:** [JSModule bridge](./rpc/jsmodule-bridge), worker-owned state, events.

**Build it step by step:** [How this was built](./tutorials/search-service)

## Note editor — SharedStore

`workers/notes.ts` · `screens/NotesScreen.tsx`

The editor writes `doc.text` on every keystroke; a worker subscribed to that path
computes word counts and debounces an autosave, writing results back to `stats`.
The two never exchange a message about the document.

Counters on screen make `batch()` concrete: 36 writes produce 36 live
notifications plus **one** for the three-field save. A switch turns batching off
so you can watch that become three.

**Shows:** [SharedStore](./shared-data/shared-store), `subscribeIn`, `batch`,
and the subscribe-before-write ordering rule from
[Names & lifetime](./shared-data/lifetime).

**Build it step by step:** [How this was built](./tutorials/note-editor)

## Transfer manager — SharedValue

`workers/downloads.ts` · `screens/DownloadsScreen.tsx`

Six simulated transfers run in a worker, each with a progress cell and a state
cell. The host **samples** progress while it renders rather than subscribing to
it — 1389 shared writes against 581 rendered frames in one measured run.
Only state transitions, which are rare, come back as real calls.

**Shows:** [SharedValue](./shared-data/shared-value), numeric cells on the atomic
path, and when polling beats subscribing.

**Build it step by step:** [How this was built](./tutorials/transfer-manager)

## Image filters — SharedBuffer

`workers/imagefx.ts` · `screens/ImageFxScreen.tsx`

144KB of RGBA pixels in one shared block, filtered in a worker and returned as a
PNG. A heartbeat measures the worst UI frame gap during the run: ~270ms of pixel
work costs the JS thread about one frame. A button runs the same blur on the JS
thread for contrast.

**Shows:** [SharedBuffer](./shared-data/shared-buffer) for bulk data, and what
"off the JS thread" is actually worth.

**Build it step by step:** [How this was built](./tutorials/image-filters)

## Sensor stream — ring buffer + `withLock`

`workers/sensor.ts` · `screens/SensorScreen.tsx`

A worker samples a signal into a ring buffer at a rate the UI does not control;
the screen draws the most recent window whenever it repaints. Producer and reader
run at completely independent rates, and old samples are overwritten rather than
queued.

This is the example where the lock earns its place: the producer writes a burst
*and* its cursor together, and the reader copies out a consistent window, so a
repaint can never catch half a burst.

**Shows:** `withLock`, producer/consumer at different rates, backpressure by
overwrite.

**Build it step by step:** [How this was built](./tutorials/sensor-stream)

## Parallel parse — nested workers

`workers/parse.ts` · `screens/ParseScreen.tsx`

A coordinator worker generates ~2.6MB of log lines into a `SharedBuffer` and
spawns child workers to parse byte ranges of it. Children open the same memory —
the text is never copied — and return only their tallies.

It sweeps 1/2/4/8 workers and shows measured speedup (~1.9× / 3.2× / 4.2× on a
simulator). The totals are identical across every run, which is what proves the
mid-line chunk alignment is counting each line exactly once.

**Shows:** nested workers, fan-out over shared memory, map-reduce.

**Build it step by step:** [How this was built](./tutorials/parallel-parse)

## UIWorker — direct UI calls

`workers/uidemo.ts` · `screens/UIWorkerDemoScreen.tsx`

A worker running on the platform main thread animating a view through direct
native calls, including while the JS thread is deliberately blocked.

The native module it calls lives in `example-modules/uiworker-demo/` — outside
the library, because *how* you use a UIWorker is application code, not library
scope. It is a Cxx TurboModule specifically because those have no method queue
and run synchronously on the calling thread; an ObjC TurboModule would dispatch
and defeat the point.

**Shows:** [UIWorker](./guides/ui-worker), zero-dispatch native calls
(~0.1µs/call), and how to add your own main-thread native API.

**Build it step by step:** [How this was built](./tutorials/uiworker-demo)
:::note[iOS only]
The demo native module is iOS-only. The `UIWorker` runtime itself works on both
platforms.
:::

## NativeScript interop — the whole iOS SDK from a worker

`workers/nativescript.ts` · `screens/NativeScriptScreen.tsx`

:::warning[Experimental]
This example depends on `@nativescript/react-native` (a preview package, iOS
only) and on techniques that live outside this library's supported API —
regenerated interop metadata, a Metro stub, runtime Obj-C class building. It's
here to show how far a `UIWorker` can go, not as a blessed pattern. Treat it as a
demo, not a dependency.
:::

The previous example needed a hand-written native method per UI call.
[`@nativescript/react-native`](https://github.com/NativeScript/napi-ios) removes
that step: it exposes every Obj-C class, C function and constant to JS through
libffi, so a worker can build UIKit views with no native module at all.

It fits a `UIWorker` exactly. Its `install()` is a Cxx TurboModule method, so the
interop host object is installed onto *the calling* runtime — each worker gets
its own copy, wired to its own CallInvoker. And it gates UIKit on
`NSThread.isMainThread` rather than on being the RN JS thread, which a UIWorker
satisfies: `runOnUI()` and its per-call `dispatch_sync` are unnecessary, and
every message send is direct and synchronous (~11µs/call in a debug build).

The screen renders an empty RN `View`; the worker finds it by its Fabric tag
(`findNodeHandle()` on one side, `viewWithTag:` on the other), builds a
`UIView` + `CAGradientLayer` + `UILabel` inside it, and drives a 60fps animation
from its own timer — which keeps running while the JS thread is blocked.

**Shows:** [UIWorker](./guides/ui-worker), third-party JSI interop resolving
inside a worker, imperative UIKit with no native module and no Fabric commit.

:::note[iOS only]
NativeScript's Native API interop is the `napi-ios` project and ships no Android
sources, so the package is excluded from the Android build in
`example/react-native.config.js`. The `UIWorker` runtime itself works on both
platforms.
:::

:::tip[React Native's own classes]
The metadata `@nativescript/react-native` ships is generated from the bare iOS
SDK: 5243 classes, none of them `RCT*`. The `nativescript-rn-generate-metadata`
CLI that is supposed to extend it is a stub in `9.0.0-preview.4` — it prints its
config and writes nothing.

So the example regenerates it. `scripts/generate-nativescript-metadata.mjs`
drives the real `objc-metadata-generator` (built from the `refactor` branch of
[NativeScript/napi-ios](https://github.com/NativeScript/napi-ios), which links
against Xcode's own libclang) against this app's CocoaPods headers, and a build
phase installed by the Podfile copies the result into the app bundle — where
`NativeScriptNativeApiModule` looks *before* the pod's resource bundle, so
nothing inside `node_modules` is touched.

The result: 5427 classes, 182 of them `RCT*`. `RCTView` and friends get lazy
globals and typed signatures, and RN's C functions come along too — the demo
calls `RCTKeyWindow()` from the worker and reads the window's bounds back.

Without regenerated metadata RN classes are still reachable via
`NativeScript.getClass()`, which falls back to `objc_lookUpClass` and derives
signatures from the Obj-C runtime's type encodings — but with no globals and no
types.
:::

:::tip[Bundling]
The package's entry point also exports `defineUIKitView()`, a React component,
which drags RN's renderer into any graph that imports it. `example/metro.config.js`
resolves that one module to a stub in worker graphs, taking the worker bundle
from 4.8MB to 366KB. A worker cannot render React anyway.
:::

## Native components defined in JS — a component library in a UIWorker

`workers/nativecomponents.ts` · `workers/helpers/native-component.ts` ·
`native-components/createWorkerComponent.tsx` · `screens/NativeComponentScreen.tsx`

:::warning[Experimental]
Builds on the NativeScript interop above (same caveats), plus runtime view-manager
registration. A demo of what's possible from a `UIWorker`, not a supported API.
:::

This goes a step past the interop demo: instead of driving UIKit imperatively, the
worker defines **real React Native host components** — Fabric mounts them and Yoga
lays them out like `RCTView` — with their view managers written entirely in
JavaScript and registered from inside the `UIWorker` at runtime. No native code,
no codegen, no podspec.

It's all powered by [NativeScript](https://nativescript.org), whose
[`@nativescript/react-native`](https://github.com/NativeScript/napi-ios) package
exposes the full Obj-C runtime to JS — every class, C function, and struct maker —
so the worker can build UIKit views and Obj-C classes with no native module.

Components are plain classes that declare their props and events:

```ts
class WorkerSwitch extends NativeComponent {
  static props = ['value', 'tint'];
  static events = ['onValueChange'];

  create() {
    const view = UISwitch.alloc().initWithFrame(CGRectMake(0, 0, 51, 31));
    this.onControl(view, UIControlEvents.ValueChanged, () =>
      this.emit('onValueChange', { value: view.on })
    );
    return view;
  }
  update(props) {
    if (props.value != null && this.view.on !== !!props.value) {
      this.view.setOnAnimated(!!props.value, true);
    }
  }
}

registerComponents([WorkerBadge, WorkerSwitch, WorkerMap]);
```

The helper `registerComponents()` builds an Obj-C `RCTViewManager` subclass at
runtime (via NativeScript's `extend`) whose `-view` returns your `create()`, adds a
`+propConfig_<name>` class method per declared prop, names it `<Component>Manager`,
and calls `RCTRegisterModule` — which is exactly what puts it in the list React
Native's legacy-interop layer scans. On the host,
`createWorkerComponent(descriptor)` resolves it through
`NativeComponentRegistry.get`. **Props ride React Native's own native pipeline**, and
**events come back over the worker's RPC channel** (keyed by React tag). It's used
like any component from a native library:

```tsx
<WorkerMap
  lat={37.77} lng={-122.42} radius={12} mapType="standard" pins={pins}
  onSelectPin={(e) => console.log('tapped', e.nativeEvent.title)}
  onRegionChange={(e) => console.log('region', e.nativeEvent)}
  style={{ height: 260 }}
/>
```

`WorkerMap` is a full `MKMapView` with a JS-defined `MKMapViewDelegate` — custom
`MKMarkerAnnotationView`s, pin-selection and region-change callbacks — plus
struct-based camera control, all in worker JavaScript.

**Shows:** [UIWorker](./guides/ui-worker) as a persistent host for a component
library (this is the example that motivates the shared-runtime default — the view
managers register once and survive navigation), runtime native-component
registration, native props via runtime `propConfig` class methods, and events over
the worker's RPC channel.

**Build it step by step:** [Native components in JS](./tutorials/worker-native-components)
— a detailed walk-through of the helpers, the flow, and the wiring.

:::note[iOS only]
Depends on the NativeScript interop, which is iOS only.
:::

:::info[Why the persistent UIWorker runtime matters here]
`RCTRegisterModule` is permanent — React Native has no way to unregister a view
manager. So the runtime that owns those classes must live as long as the
registration: for the whole process. This is precisely why UIWorker runtimes are
[shared and persistent](./guides/ui-worker#shared-persistent-runtimes) by default.
Navigating away calls `terminate()` (a handle disconnect, not a teardown) and back
**reconnects** to the same runtime — the components keep working with no
re-registration. Using `independent` or `terminateRuntime()` here would break that;
see the warning in the UIWorker guide.
:::

## Tests and benchmarks

Two more screens run the conformance suite (Web Worker semantics, structured
clone, native modules, bridge, shared primitives) and the benchmark set. They are
the fastest way to check a change on a device.
