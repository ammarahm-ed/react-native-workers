---
sidebar_position: 4
title: 4. Image filters (SharedBuffer)
---

# Building the image filter pipeline

**What you’ll build:** 144KB of RGBA pixels in shared memory, filtered in a
worker, displayed as a PNG — with a measurement proving the JS thread stayed free.

**The idea to take away:** `SharedBuffer` is for bulk data. One native call gets
you an `ArrayBuffer`; after that it is plain JS typed-array access at full speed.

Files: `example/src/workers/imagefx.ts` · `example/src/screens/ImageFxScreen.tsx`

## Step 1: size the problem

192 × 192 RGBA = 147,456 bytes. Sent as a message, that is a structured clone of
144KB in each direction, per filter pass. Held in a `SharedBuffer`, it is copied
**zero** times: both runtimes put a `Uint8Array` over the same native memory.

The rule of thumb: if the data is large and the work is repeated, share it.

## Step 2: allocate on one side, open on the other

```tsx
// host allocates
const names = { src: ns + ':src', dst: ns + ':dst' };
new SharedBuffer(names.src, W * H * 4);
new SharedBuffer(names.dst, W * H * 4);
await w.module('imagefx').init(names.src, names.dst, W, H);
```

```ts
// worker opens the same names
src = new Uint8Array(new SharedBuffer(srcName, bytes).arrayBuffer);
dst = new Uint8Array(new SharedBuffer(dstName, bytes).arrayBuffer);
```

Whoever opens a name **first** fixes its `byteLength`; later openers get that
size. Passing the same length from both sides keeps it honest.

Two buffers, not one, because every filter reads the source and writes the
destination. Filtering in place would mean a blur reading pixels it had already
modified.

## Step 3: write filters as ordinary loops

```ts
function grayscale(s: Uint8Array, d: Uint8Array) {
  for (let i = 0; i < s.length; i += 4) {
    const g = (s[i]! * 0.299 + s[i + 1]! * 0.587 + s[i + 2]! * 0.114) | 0;
    d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = s[i + 3]!;
  }
}
```

Nothing worker-specific here — it is a normal typed-array loop over 147k bytes.
That is the point. There is no per-element boundary crossing to design around;
once you hold the `ArrayBuffer`, the shared-ness is invisible.

## Step 4: return the result, not the pixels

The host needs something `<Image>` can render, so the worker encodes a PNG and
returns a base64 string:

```ts
return { filter, filterMs, encodeMs, png: encodePng(dst) };
```

The encoder is ~70 lines of pure JS — CRC32, Adler32, deflate **stored** blocks
(no compressor needed) and base64. It runs in the worker too, so neither the
pixel work nor the encoding touches the JS thread.

:::note[Why this is acceptable here and wrong per-frame]
The base64 string is ~200KB and it *does* cross the bridge. That is fine for a
one-shot filter and completely wrong for anything per-frame. If you needed live
preview, you would render from the shared pixels directly rather than encoding.
:::

## Step 5: measure the thing you are claiming

Saying "it doesn't block the UI" is easy; a spinner keeps spinning even when the
thread is wedged. So the screen runs a heartbeat and records the worst gap:

```tsx
const id = setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick.current;
  lastTick.current = now;
  if (gap > worstGap.current) worstGap.current = gap;
}, 16);
```

If the JS thread stalls, the interval cannot fire, and the next gap exposes
exactly how long it was stuck. Measured result: **248ms filter + 22ms encode, and
a worst frame gap of 21ms** — about one frame.

Use this trick whenever you want to demonstrate responsiveness. It cannot be
faked.

## Step 6: build the counter-example

The screen has a deliberately wrong button that runs the same blur on the JS
thread, reading the same shared pixels:

```tsx
const src = new Uint8Array(bufRef.current.arrayBuffer);
// ...same nested loops, on the JS thread...
```

Measured: **152ms of work, worst frame gap 157ms** — the JS thread was gone for
the entire duration. The worker path, doing *more* work (248ms + 22ms encode),
left a 21ms gap.

Note the two blurs are the same *kind* of work but not identical: the host
version runs horizontal passes only, which is why it is cheaper in absolute
terms. That is deliberate — the comparison to draw is between the **frame gaps**,
not the durations.

This also shows the host can read the shared pixels as freely as the worker can.
The buffer is not "the worker's".

## Step 7: release it

```ts
release(srcName: string, dstName: string) {
  SharedBuffer.delete(srcName);
  SharedBuffer.delete(dstName);
}
```

Buffers are the largest of the three primitives, so a leaked name matters most
here. Note the detach semantics: `ArrayBuffer`s handed out earlier stay valid
(they keep the bytes alive), but re-opening the name allocates **fresh** memory
that no longer aliases them.

## What to take away

- One native call, then raw typed-array speed — bulk data belongs here.
- Separate source and destination buffers for read-modify-write passes.
- Return the small derived result, not the big input.
- Measure blocking with a heartbeat, not a spinner.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=imagefx yarn start --reset-cache
```

Press each filter, then press the red button and compare the frame gap. Raise
`W`/`H` to 512 and watch the filter time grow while the frame gap does not.

Next: [Sensor stream (withLock)](./sensor-stream) →
