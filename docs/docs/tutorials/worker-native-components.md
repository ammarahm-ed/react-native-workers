---
sidebar_position: 8
title: 8. Native components in JS (UIWorker)
---

# Building a native component in JavaScript

**What you'll build:** `WorkerSwitch` — a real, native `UISwitch` used from React
like any component from a native library:

```tsx
<WorkerSwitch value={on} onValueChange={setOn} style={{ width: 51, height: 31 }} />
```

Fabric mounts it, Yoga lays it out, its `value` flows down as a **native prop** and
its change event comes back up to React state — but **its view manager is written
entirely in JavaScript and registered from inside a `UIWorker` at runtime.** No
native code, no codegen, no podspec. The same pattern builds `WorkerBadge` (a styled
label) and `WorkerMap` (a full `MKMapView` with a JS delegate).

Files: `example/src/workers/nativecomponents.ts` ·
`example/src/workers/helpers/native-component.ts` ·
`example/src/native-components/createWorkerComponent.tsx` ·
`example/src/screens/NativeComponentScreen.tsx`

:::warning[Experimental]
This builds on [`@nativescript/react-native`](../examples#nativescript-interop--the-whole-ios-sdk-from-a-worker)
(a preview package, **iOS only**) and on runtime Obj-C class building and
view-manager registration. It's a demonstration of how far a `UIWorker` can go —
not a supported, blessed API. Read it for the ideas; treat the code as a demo.
:::

:::note[What is NativeScript?]
[NativeScript](https://nativescript.org) is an open-source runtime that exposes the
entire native platform API to JavaScript. Its
[`@nativescript/react-native`](https://github.com/NativeScript/napi-ios) package
(the `napi-ios` project) brings that to iOS via libffi/JSI, so from JS you can call
any Obj-C class, C function, struct maker, and constant — including UIKit and the
RN Obj-C runtime. That's the one dependency that makes everything below possible; it
is not part of this library. See [nativescript.org](https://nativescript.org) for
the project.
:::

## The idea

A React Native "host component" (like `<View>`) is backed by a **native view
manager** — an Obj-C `RCTViewManager` subclass that builds the platform view and
declares its props. Normally you write that in Objective-C and run codegen.

But a [`UIWorker`](../guides/ui-worker) runs JS **on the main thread**, and
[`@nativescript/react-native`](../examples) exposes the whole Obj-C runtime to that
JS. So from worker JavaScript we can do everything the native manager would:

1. **build** the `UIView` (`UISwitch.alloc().init…`),
2. **subclass** `RCTViewManager` and **register** it with React Native,
3. **declare props** so RN sends them down natively, and
4. **respond** to the view's events.

React Native then treats the result as a genuine component. Props ride RN's **own
native prop pipeline** and events ride its **own event pipeline** — nothing crosses
the worker's RPC bridge at runtime (it's used once, at startup, to fetch the list of
components). Let's build it.

## Step 1: a component is a class

The example wraps the mechanics in a small base class, `NativeComponent`
(`helpers/native-component.ts`). You write a subclass that declares its props and
events, and implements two methods:

```ts title="workers/nativecomponents.ts"
import { NativeComponent, registerComponents, serveComponents }
  from './helpers/native-component';

class WorkerSwitch extends NativeComponent {
  static props = ['value', 'tint'];
  static events = ['onValueChange'];

  create() {
    // Build the real UIKit view. Runs on the main thread.
    const view = UISwitch.alloc().initWithFrame(CGRectMake(0, 0, 51, 31));
    this.onControl(view, UIControlEvents.ValueChanged, () =>
      this.emit('onValueChange', { value: view.on })
    );
    return view;
  }

  update(props: { value?: boolean; tint?: boolean }) {
    // Apply props. Called on mount and on every host-side change.
    if (props.value != null && this.view.on !== !!props.value) {
      this.view.setOnAnimated(!!props.value, true);
    }
    if (props.tint) this.view.onTintColor = UIColor.systemGreenColor;
  }
}
```

- **`static props`** lists the prop names RN should route to `update()`.
- **`static events`** lists the `on<Event>` callback prop names.
- **`create()`** builds and returns the `UIView`. The base class stores it as
  `this.view`. One instance per mounted view.
- **`update(props)`** applies props (accumulated, so read whatever you need off
  `props`); `this.view` is always available.
- **`this.emit(event, payload)`** fires the matching `on<Event>` React prop, with
  `payload` delivered as `event.nativeEvent`.
- **`this.onControl(control, events, handler)`** wires a UIKit control event.

:::tip[Wire events in `create()`, not `update()`]
A native proxy isn't a stable JS identity, so a `view.__wired` guard doesn't
survive, and wiring from `update()` would add a *fresh* target/action on every prop
change (double-firing events). Do it once, in `create()`.
:::

## Step 2: register it with React Native

One call publishes your classes:

```ts title="workers/nativecomponents.ts"
registerComponents([WorkerBadge, WorkerSwitch, WorkerMap]);
serveComponents();
```

`registerComponents` is where the runtime magic happens. For each class it builds an
Obj-C view manager and drops it into RN's module list:

```ts
const Manager = RCTViewManager.extend(
  {
    view() { /* new instance; return instance.create() */ },
    // ...one propConfig + setter per declared prop (Step 4)
  },
  { name: `${name}Manager`, exposedMethods /* signatures for the new methods */ }
);
RCTRegisterModule(Manager);
```

Three details make this work, all Obj-C-runtime facts you can lean on:

1. **`RCTViewManager.extend({ view() {…} }, …)`** allocates a real Obj-C class at
   runtime whose `-view` method is your JS function. (`-view` already exists on
   `RCTViewManager`; NativeScript's `extend` can override existing members.)
2. **The class is named `<Component>Manager`.** `RCTViewManager` uses
   `RCT_EXPORT_MODULE()` with no argument, so its `+moduleName` is `@""`, and
   RN's legacy-interop layer falls back to *"class name minus `Manager`"* to name
   the component. So `WorkerSwitchManager` → the component `WorkerSwitch`.
3. **`RCTRegisterModule()`** drops the class into `RCTGetModuleClasses()` — the
   exact list RN scans when deciding whether a component name is supported.

When the host later renders `<WorkerSwitch>`, Fabric asks
`RCTComponentViewFactory` if the name is supported, the scan finds
`WorkerSwitchManager`, and RN mounts a legacy-interop view whose coordinator calls
your `-view` to build the `UISwitch`.

`serveComponents()` exposes a tiny RPC module (`nativecomponents`) with a single
`list()` method that returns the registered component descriptors — the host queries
it **once** to learn each component's name, props, and events. It's not on the
per-prop path.

## Step 3: resolve it on the host

The host side (`native-components/createWorkerComponent.tsx`) turns a component
descriptor into a React component:

```tsx
import * as NativeComponentRegistry
  from 'react-native/Libraries/NativeComponent/NativeComponentRegistry';

const validAttributes = {};
for (const prop of descriptor.props) validAttributes[prop] = true;

const Host = NativeComponentRegistry.get(descriptor.name, () => ({
  uiViewClassName: descriptor.name,
  validAttributes,   // the native props RN is allowed to send down
}));
```

Why `NativeComponentRegistry.get` and **not** `requireNativeComponent`? The public
`requireNativeComponent` takes the legacy path and asks *native* for the view
config — which a view manager registered at runtime can't answer. In bridgeless
mode `NativeComponentRegistry.get` uses the **static** view config
(`native: !global.RN$Bridgeless`), i.e. the JS-authored one you pass in. The
`validAttributes` map is what tells RN which props are real native props to send
down the pipeline — so it must list exactly the names the worker declared.

## Step 4: props go down natively

Props flow down **React Native's own native pipeline** — the same one a codegen'd
component uses. You declare a prop's name in `static props`, and `registerComponents`
does the rest: it tells RN about the prop and wires a setter that calls straight into
your `update()`.

```ts
// the helper's setter, added per declared prop — RN calls it when the prop changes:
set_value(json, view) {
  const instance = instances.get(view);   // view → your NativeComponent
  const state = { ...prevProps, value: toJS(json) };
  instance.update(state);                  // your update() runs, on the main thread
}
```

So a prop change on the host travels down RN's commit → mount pipeline and calls
your worker's `update()` directly — no RPC message, no tag bookkeeping. The host
wrapper does nothing but forward the prop:

```tsx
<Host ref={ref} style={style} {...nativeProps} />   // RN sends value/tint down natively
```

Style and layout still go through Yoga natively, and the `RCTView` props the manager
inherits (`backgroundColor`, `opacity`, …) keep working the native way.

## Step 5: events go up natively too

Events flow through React Native's **own** event pipeline — no bridge. RN hands the
view a native dispatching block through a `set<Event>:` setter; we capture that block
and, when the control fires, invoke it. The one wrinkle: NativeScript can't *call* a
runtime-supplied native block directly, so we let the Obj-C runtime do it. The helper
handles this — components just declare `static events` and call `this.emit()`:

```ts
// build the view so RN's event blocks are captured, then emit normally:
create() {
  const view = this.eventView(UISwitch).alloc().initWithFrame(CGRectMake(0, 0, 51, 31));
  this.onControl(view, UIControlEvents.ValueChanged, () =>
    this.emit('onValueChange', { value: view.on })
  );
  return view;
}
```

`this.emit('onValueChange', payload)` invokes RN's dispatching block, RN's event
system routes it, and the payload arrives at the React callback as
`{ nativeEvent: payload }` — **exactly** like a native component's event:

```tsx
<WorkerSwitch onValueChange={(e) => setOn(e.nativeEvent.value)} />
```

On the host, the only extra step is telling RN about the event names, which
`createWorkerComponent` does from the descriptor (a `bubblingEventTypes` entry per
`on<Event>`); the `on*` callbacks then pass straight through to the view.

:::note[How the block gets invoked]
NativeScript refuses to call a native block it was handed at runtime (it has no
metadata signature to build the call from). The Obj-C runtime has no such
limitation: `imp_implementationWithBlock` turns the block into a method IMP, and
messaging that method invokes it. The helper captures RN's block via `eventView()`
and fires it this way — you never see any of it.
:::

## Step 6: use it like any component

Put it together on the host:

```tsx title="screens/NativeComponentScreen.tsx"
const w = new UIWorker('../workers/nativecomponents', { nativeModules: true });

await w.ready('nativecomponents', 8000);
const descriptors = await w.module('nativecomponents').list(); // one-time query
const WorkerSwitch = createWorkerComponent(descriptors.find(d => d.name === 'WorkerSwitch'));

// ...then render it like anything else:
<WorkerSwitch
  value={on}
  tint
  onValueChange={(e) => setOn(e.nativeEvent.value)}
  style={{ width: 51, height: 31 }}
/>
```

`value` flows down as a native prop; the change event comes back up through RN's
native event pipeline to React state — the whole loop running through the worker, on
the main thread, with no bridge in either direction.

## It's native the whole way

Both directions ride React Native's own pipelines: props go down RN's prop pipeline
(batched into each commit), events come up RN's event pipeline (delivered as
`{ nativeEvent }`). Nothing crosses the worker's RPC bridge at runtime — the bridge
is used only **once**, to fetch the component descriptors at startup.

That means a worker-defined component behaves like a codegen'd one: props are
batched with reconciliation, events dispatch through RN's own event system, and both
cross the JS-thread → UI-thread boundary exactly once (the cost that actually
matters). No per-prop or per-event message, no tag bookkeeping.

## The reusable pieces

Everything component-*specific* is just the `WorkerSwitch` class. The rest is
generic plumbing you'd extract into a library once and never touch again — two
small helpers.

**Worker side — `helpers/native-component.ts`:**

| Export | What it does |
| --- | --- |
| `class NativeComponent` | The base class: declare `static props` / `static events` (and optional `static componentName`), implement `create()` / `update(props)` / `dispose()`. Gives you `this.view`, plus `emit(event, payload)`, `eventView(Base)` (the view class to build so RN's event blocks are captured), `onControl(control, events, cb)`, and `delegate(protocols, methods)` for Obj-C delegates from JS. One instance per mounted view. |
| `registerComponents(classes)` | For each class, builds a runtime `RCTViewManager` subclass: a `-view` method, per declared prop the metadata + setter RN needs to send it down natively, and per declared event the `RCTBubblingEventBlock` propConfig RN needs to wire it up. Registers it with `RCTRegisterModule`, remembers `name → descriptor` (re-registering the same name is a no-op), and returns the descriptors. |
| `serveComponents()` | Registers the `nativecomponents` RPC module with a single `list()` that returns the descriptors — a one-time host query, not a runtime channel. |

**Host side — `native-components/createWorkerComponent.tsx`:**

| Export | What it does |
| --- | --- |
| `createWorkerComponent(descriptor)` | Returns a React component. Resolves the host view via `NativeComponentRegistry.get` (props → `validAttributes`, events → `bubblingEventTypes`) and forwards all props and `on*` callbacks straight to it — RN drives both natively. |

To add a **new** component you write only a new `NativeComponent` subclass (declaring
its `props`/`events`) and drop it into `registerComponents([...])`. The helpers don't
change — that's the whole idea.

## The whole flow

Three things happen: the worker **registers** a view manager with RN (once); the
host **mounts** the component, which drives RN to call the worker's `create()`; and
at runtime **props flow down** and **events flow up**, both through RN's own native
pipelines.

```mermaid
flowchart TB
  subgraph W["UIWorker — main thread"]
    WC["class WorkerSwitch<br/>static props / events<br/>create() / update()"]
    WR["registerComponents()"]
    WM["RCTViewManager.extend<br/>+ propConfig class methods<br/>+ RCTRegisterModule"]
    WV["create() builds UISwitch<br/>(eventView captures RN's block)"]
    WE["emit('onValueChange', {value})<br/>→ invoke RN's block"]
  end

  subgraph RN["React Native core"]
    RG["RCTGetModuleClasses()"]
    RI["isSupported 'WorkerSwitch'<br/>→ WorkerSwitchManager"]
    RM["Fabric mounts interop view"]
    RV["coordinator calls -view"]
    RP["prop change → set_value:forView:"]
    RE["event dispatcher"]
  end

  subgraph H["Host — JS thread"]
    HR["createWorkerComponent(descriptor)"]
    HG["NativeComponentRegistry.get<br/>props → validAttributes<br/>events → bubblingEventTypes"]
    HJ["render the WorkerSwitch element"]
  end

  WC --> WR --> WM --> RG
  HR --> HG
  HJ --> HG --> RM --> RI
  RI -. name matches .-> WM
  RM --> RV --> WV --> WC
  HJ -- "props down: native pipeline" --> RP --> WC
  WE -- "event up: native block" --> RE --> HJ
```

Read it as three passes: the **registration** path (`WorkerSwitch` →
`registerComponents` → `RCTRegisterModule` → `RCTGetModuleClasses`), the **mount**
path (render → `NativeComponentRegistry.get` → Fabric → `-view` → your `create()`),
and the two runtime channels — props down through RN's native `set_<name>:` setter
into your `update()`, and events up through RN's own event dispatcher back to your
callback prop.

## Why the persistent UIWorker runtime matters

This example is the reason [`UIWorker` runtimes are shared and persistent by
default](../guides/ui-worker#shared-persistent-runtimes). `RCTRegisterModule` is
**permanent** — React Native has no way to *unregister* a view manager. So the
runtime that owns those classes' `-view` closures must live as long as the
registration: for the whole process.

That's exactly what the persistent default gives you. The natural per-screen
pattern just works:

```tsx
useEffect(() => {
  const w = new UIWorker('../workers/nativecomponents', { nativeModules: true });
  // ...resolve + render...
  return () => w.terminate(); // disconnect this handle; runtime persists
}, []);
```

- **First visit** evaluates the worker and registers the managers.
- **Navigating away** calls `terminate()` — a handle disconnect, *not* a teardown.
- **Coming back** reconnects to the same runtime; the managers are already
  registered, so it just works, instantly.

:::danger[Do not use `independent` or `terminateRuntime()` here]
Both recreate the runtime, and a second runtime that registers the same component
names collides — while RN's cache still points the name at the reaped runtime,
which crashes on the next render. This is an RN limitation, not a worker bug. A
component-registering worker must be the shared, persistent kind. See the warning
in the [UIWorker guide](../guides/ui-worker#opting-out-independent).
:::

## Going further: `WorkerMap`

`WorkerBadge` follows the same shape with a `UILabel`. `WorkerMap` goes further: a
full `MKMapView` whose `MKMapViewDelegate` is written in JS via
`this.delegate('MKMapViewDelegate', { … })` — custom `MKMarkerAnnotationView`s,
pin-selection and region-change callbacks, and struct-based camera control
(`CLLocationCoordinate2DMake`, `MKCoordinateRegionMakeWithDistance`). Its `lat`,
`lng`, `radius`, `mapType`, and `pins` are all native props that move the camera and
the annotations; the map's own `onSelectPin` / `onRegionChange` come back up RN's
native event pipeline. Building a delegate from JS is the single hardest thing in
Objective-C interop, and it's a few lines here. See `workers/nativecomponents.ts` for
the full component.

## What to take away

- A `UIWorker` + full Obj-C interop lets you register a **real** RN view manager at
  runtime, entirely in JS — no native module, codegen, or podspec.
- **Props and events are both native** — props ride RN's commit/mount pipeline
  (batched with reconciliation), events ride RN's event dispatcher (delivered as
  `{ nativeEvent }`). The RPC bridge is used only once at startup, to list the
  components.
- Events work because the Obj-C runtime can invoke RN's native event block
  (`imp_implementationWithBlock`) even though NativeScript can't call it directly.
- It only works because the worker runtime is **persistent** — permanent native
  registration demands a permanent runtime.
- It's iOS-only and experimental, but it shows the ceiling of what worker-driven
  native UI can be.
