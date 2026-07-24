---
sidebar_position: 7
title: 7. UIWorker native calls
---

# Building the UIWorker demo

**What you’ll build:** a worker running on the platform main thread that
animates a view through **direct** native calls — continuing smoothly even while
the JS thread is deliberately blocked.

**The idea to take away:** a `UIWorker` puts a Hermes runtime *on* the main
thread. To get value from that you need a native module that runs synchronously
on the calling thread, and that constrains what kind of module you can write.

Files: `example/src/workers/uidemo.ts` · `example/src/screens/UIWorkerDemoScreen.tsx` ·
`example-modules/uiworker-demo/`

:::note[iOS only]
The demo native module is iOS-only. The `UIWorker` runtime itself works on both
platforms.
:::

## Step 1: understand what a UIWorker gives you — and what it doesn't

A `UIWorker` runs your JS on the main thread. On its own that changes nothing
about how you reach native APIs: the standard module surface still dispatches.

Vibration, alerts and most native calls already hop to the main thread
internally, so invoking them *from* the main thread saves nothing. A demo built
on those would show no difference at all.

**The win only exists if the call itself is direct.** Which forces a decision
about module type.

## Step 2: pick a Cxx TurboModule (this is the whole trick)

| Module kind | Behaviour when called |
| --- | --- |
| ObjC TurboModule | Void methods are **always async** — posted to the module's method queue (`performVoidMethodInvocation`, `RCTTurboModule.mm`). Never a direct call, whatever thread you are on. |
| Java TurboModule | Similar dispatch to the native modules queue. |
| **Cxx TurboModule** | **No method queue.** Runs synchronously on the calling runtime's thread. |

So the demo module is a C++ TurboModule. Inside a `UIWorker`, the calling thread
*is* the main thread, so `demo.setViewTransform(...)` reaches UIKit with no
dispatch and no serialisation — measured at **~0.1µs per call** over 10k
iterations.

If you take one thing from this example, take this table.

## Step 3: put example-only native code outside the library

The module lives in `example-modules/uiworker-demo/` — a private package the
example links locally:

```json
{ "name": "react-native-uiworker-demo", "private": true, "main": "src/index.ts" }
```

This is deliberate. *How* you use a UIWorker is application code; the library
provides the runtime and the primitives, not an opinion about your UI. Keeping it
outside also means the demo can do whatever it likes — C++, ObjC, direct UIKit —
without any of it becoming supported API.

Structure:

```text
example-modules/uiworker-demo/
  cpp/UIWorkerDemoModule.h    Platform interface + TurboModule subclass
  cpp/UIWorkerDemoModule.cpp  methodMap_, main-thread guard
  ios/UIWorkerDemoIOS.mm      the actual UIKit calls
  src/index.ts                typed JS interface
  UIWorkerDemo.podspec
```

The C++ layer is platform-agnostic and talks to a small `Platform` interface;
the `.mm` file implements it. That split is what would let Android join later.

## Step 4: make the module reachable from a worker

A worker runtime is not the host runtime, so it does not automatically see host
modules. Registering into the **global module map** makes the module resolvable
by name from any runtime:

```cpp
void UIWorkerDemoModule::registerSelf() {
  registerCxxModuleToGlobalModuleMap(
      std::string(kModuleName), /* ...factory... */);
}
```

On iOS this is called from `+load`, so it happens before any worker starts. From
JS:

```ts
import { getUIWorkerDemo } from 'react-native-uiworker-demo';
const demo = getUIWorkerDemo(); // uses globalThis.__rnworkersGetModule
```

:::note[No `{ nativeModules: true }` required]
The lightweight **Cxx-only** binding is installed in *every* worker, so a Cxx
TurboModule resolves with no opt-in. The `{ nativeModules: true }` flag opts into
the heavyweight Java/ObjC TurboModule manager — which costs memory and needs
teardown, and which this module does not use. The demo screen passes the flag
anyway; that is redundant, not required.
:::

## Step 5: fail loudly off the main thread

Touching UIKit off the main thread corrupts state in ways that surface much later.
So every UI method guards:

```cpp
requireMainThread(rt, "setViewTransform");
// throws: "...must run on the main thread. Create the worker with `new UIWorker(...)`"
```

The demo screen spawns the *same worker file* twice — once as a `UIWorker`, once
as a background `Worker` — so you can see `info()` report different threads and
watch the UI methods throw on the wrong one. Design your native modules so the
mistake is impossible to miss.

## Step 6: address views without private headers

Fabric assigns the React tag to `UIView.tag`, so UIKit's own `viewWithTag:`
resolves a component view — no private headers needed:

```tsx
const tag = findNodeHandle(boxRef.current); // host passes the tag to the worker
```

```ts
if (!demo.viewExists(tag)) { /* React unmounted it — stop */ }
demo.setViewTransform(tag, { translateX, rotate, scale });
```

:::caution[This bypasses Fabric]
Writing to the view directly skips the shadow tree and the commit phase — the
same approach Reanimated takes. Two consequences: React does not know about these
values, and a re-render of that view **overwrites them**. Use it for transient
visual state (animation, gestures), never as your source of truth.
:::

## Step 7: drive the loop from the main thread

The animation loop lives entirely in the UIWorker:

```ts
animate(tag: number, running: string) {
  const flag = new SharedValue(running, 0);
  const tick = () => {
    if (flag.value !== 1 || !demo.viewExists(tag)) { /* stop, reset */ return; }
    const t = (Date.now() - start) / 1000;
    demo.setViewTransform(tag, { translateX: Math.sin(t * 2) * 90, rotate: t * 2 });
    demo.setViewOpacity(tag, 0.65 + Math.sin(t * 3) * 0.35);
  };
  flag.value = 1;
  timer = setInterval(tick, 16);
}
```

Note how it is stopped: the host flips a **`SharedValue`**, and the loop reads
that flag each tick. A message would have to be queued and drained by the
worker's event loop; a shared cell is a lock-free read on the thread already
running. This is the primitive combination that makes the pattern work.

The loop also checks `viewExists` every frame, because React can unmount the view
underneath a runtime that knows nothing about React.

## Step 8: prove it

The screen has a "Block JS thread 2s" button that runs a busy loop on the JS
thread. The box keeps animating throughout. That is the demonstration — an
animation driven from JS on the JS thread would freeze.

:::note[File-based UIWorkers]
The Babel plugin rewrites worker specifiers for **both** `Worker` and `UIWorker`,
so `new UIWorker('./uidemo')` resolves the same way `new Worker('./uidemo')`
does. If a file-based worker 404s, check that the plugin is installed — an
unrewritten specifier is fetched verbatim as a path.
:::

## What to take away

- A UIWorker is only worth it if your native calls are direct — which means a
  **Cxx TurboModule**, not ObjC or Java.
- `registerCxxModuleToGlobalModuleMap` makes a module reachable from workers.
- Guard main-thread-only APIs and throw clearly.
- Direct view writes bypass Fabric: transient visual state only.
- Use a `SharedValue` to control a running loop, not messages.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=uiworker yarn start --reset-cache
```

Start the animation, then block the JS thread and watch it continue.
