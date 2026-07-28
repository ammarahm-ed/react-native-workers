---
sidebar_position: 4
title: Native events (NativeEventEmitter)
---

# Native events (`NativeEventEmitter`)

Workers can subscribe to native **device events** with the familiar
`NativeEventEmitter` API, so a background worker can react to native
notifications — geolocation, bluetooth, custom module events — without involving
the JS thread.

## Subscribing inside a worker

```js
const worker = new Worker({
  inline: `
    const emitter = new NativeEventEmitter(); // or new NativeEventEmitter(someModule)
    const sub = emitter.addListener('LocationChanged', (payload) => {
      // this fires INSIDE the worker
      self.postMessage({ location: payload });
    });
    // sub.remove(); // when done
  `,
});

worker.onmessage = (e) => console.log('worker saw event:', e.data);
```

The API mirrors React Native's: `addListener(type, cb)` returns a subscription
with `.remove()`; `removeAllListeners(type)` and `listenerCount(type)` are
available too.

## How delivery works

There are two paths, and the difference is **which runtime's module emitted the
event** — not what language it was written in:

- **Events from the worker's own modules** — C++, Java or Objective-C — land
  **directly** on that worker. They are never dispatched on the host runtime and
  never copied through it. This is what makes a worker's network response
  independent of the RN JS thread; see
  [isolation rules](./native-modules#isolation-rules).
- **Events from the host app** — the app's own `DeviceEventEmitter.emit(...)`, or a
  module owned by the host — originate on the host runtime. The library forwards
  those to any worker that has registered a listener, structured-cloning the
  payload.

You don't have to think about which path an event takes; subscribing is the same.

:::note[This changed in 1.0.0-alpha.3]
Before that release, a worker module's Java/ObjC events *were* raised on the host
runtime and forwarded back — so a worker's own events depended on the RN JS thread.
That is fixed on both platforms.
:::

## Example: forwarding an app event to a worker

```js
import { DeviceEventEmitter } from 'react-native';

const worker = new Worker({
  inline: `
    new NativeEventEmitter().addListener('sync-requested', (p) => {
      self.postMessage({ started: p.id });
      // ...do the sync work here, off the JS thread...
    });
  `,
});

// somewhere in your app, on the JS thread:
DeviceEventEmitter.emit('sync-requested', { id: 42 });
```

## Notes

- A worker only receives forwarded host events **after** it has added at least one
  listener (it opts in on first `addListener`). Workers with no listeners cost
  nothing.
- Event payloads must be structured-cloneable to reach a worker; non-cloneable
  payloads are delivered to the host only.
