---
sidebar_position: 5
title: 5. Sensor stream (ring buffer + withLock)
---

import DeviceFrame from '@site/src/components/DeviceFrame';

# Building the sensor stream

**What you’ll build:** a worker sampling a signal at a rate the UI does not
control, writing into a ring buffer, with the screen drawing the most recent
window whenever it happens to repaint.

**The idea to take away:** this is the first example where the **lock** is
load-bearing. Learn when you need one — and when, as in the transfer manager, you
don't.

Files: `example/src/workers/sensor.ts` · `example/src/screens/SensorScreen.tsx`

<DeviceFrame
  width={300}
  src="/img/screens/sensor.webp"
  alt="The sensor screen drawing a live waveform from a ring buffer, with counters showing 383 samples produced, a 161Hz producer and a 30Hz reader"
  caption={<>The finished screen. The two rate counters are the whole point: the producer and the reader never agree on a rate, and neither waits for the other.</>}
/>

## Step 1: choose a ring buffer

A producer faster than its consumer has three options: queue (grows without
bound), block the producer (wrong for a sensor), or **overwrite the oldest**.
A ring buffer is the third, and it is what real sensor pipelines do — you want
the *most recent* window, not a backlog.

Layout, all `Float32` so a single view covers it:

```text
[0]        write cursor (monotonic sample count)
[1]        samples/sec the producer is achieving
[2..2+N)   the ring itself
```

Keeping the cursor **inside** the buffer matters: it is shared state that must
move with the data, not alongside it.

## Step 2: write bursts, not samples

Above ~200Hz you cannot get a timer per sample, so each tick emits a small burst:

```ts
const periodMs = Math.max(1, Math.round(1000 / hz));
const perTick = Math.max(1, Math.round(hz / (1000 / periodMs)));
```

This is worth understanding before reaching for workers as a timing solution: a
JS timer in a worker is still a JS timer. At a 200Hz target this example achieves
~175Hz. Real sensors are driven by native callbacks; the worker's value is that
the *processing* is off the JS thread, not that its clock is precise.

## Step 3: work out whether you need a lock

Ask: **can a reader observe a state no writer ever produced?**

- Transfer manager: one number per cell, written with a single store. A reader
  sees the old value or the new one. **No lock.**
- Here: a burst of samples *plus* a cursor. A reader that saw the new cursor but
  the old samples would draw a window that never existed — a torn read.
  **Lock required.**

The lock is not about corruption; it is about **consistency between related
writes**.

## Step 4: hold the lock across the related writes

```ts
buf.withLock(() => {
  for (let i = 0; i < perTick; i++) {
    v[HEADER + (cursor % capacity)] = sample;
    cursor++;
  }
  v[0] = cursor; // cursor becomes visible with the samples it describes
});
```

Every `SharedBuffer` has a cross-runtime lock keyed to the same name, reachable
with `withLock`. The whole burst plus the cursor update is one critical section,
so a reader sees the burst entirely or not at all.

## Step 5: copy out under the lock, compute outside it

```tsx
const snapshot = new Float32Array(BARS);
let cursor = 0;
buf.withLock(() => {
  cursor = v[0]!;
  for (let i = 0; i < BARS; i++) {
    const idx = cursor - BARS + i;
    snapshot[i] = idx < 0 ? 0 : v[HEADER + (idx % CAPACITY)]!;
  }
});
// ...scaling, colouring, setState — all outside the lock
```

The rule for any cross-thread lock: **copy inside, compute outside.** The
critical section is 64 float reads. Doing the drawing maths inside it would make
the producer wait on the UI, which is precisely backwards.

## Step 6: let the rates diverge

```tsx
loop = setInterval(() => { /* read + setState */ }, 33);
```

The producer runs at ~175Hz, the reader at ~30Hz. Neither knows about the other.
Nothing queues, nothing is dropped in transit — samples the UI never saw were
simply overwritten in the ring.

The screen shows all three numbers (samples produced, producer Hz, reader Hz) so
the independence is visible.

## Step 7: verify by looking at it

A torn read is a real risk with a subtle failure mode, so pick a display that
makes it obvious. A coherent sine wave means the window is self-consistent;
tearing would show as a visible discontinuity jumping around each frame.

Choosing a visualisation that *fails visibly* is worth as much as the lock.

## What to take away

- Ring buffer + overwrite is the right shape for producer-faster-than-consumer.
- You need a lock when multiple related writes must be seen together — not for
  every shared write.
- Keep critical sections tiny: copy inside, compute outside.
- A worker's timer is still a JS timer; the win is where the processing happens.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=sensor yarn start --reset-cache
```

Push the rate to 1000Hz and watch the achieved rate fall short — that is timer
granularity, not the shared memory.

:::note[On removing the lock]
Dropping `withLock` will not reliably *show* you anything: a torn read is a race,
so it may not happen for many minutes, and at these sample rates a single torn
window is a one-frame glitch that is easy to miss. That is exactly what makes the
bug dangerous, and why the reasoning in step 3 — rather than an experiment — is
what should decide whether you take the lock. Treat "I removed it and nothing
broke" as no evidence at all.
:::

Next: [Parallel parse (nested workers)](./parallel-parse) →
