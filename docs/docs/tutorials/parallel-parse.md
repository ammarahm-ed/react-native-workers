---
sidebar_position: 6
title: 6. Parallel parse (nested workers)
---

# Building the parallel parser

**What you’ll build:** a coordinator worker that generates ~2.6MB of log lines
into shared memory, spawns child workers to parse byte ranges of it in parallel,
and reduces their tallies — with the speedup measured on screen.

**The idea to take away:** workers can spawn workers. Combined with shared
memory, that gives you real map-reduce with no data copying.

Files: `example/src/workers/parse.ts` · `example/src/screens/ParseScreen.tsx`

## Step 1: the coordinator pattern

One worker acts as coordinator. It owns the corpus, decides the split, spawns
children, and reduces. The host talks only to the coordinator.

```text
host ──▶ coordinator ──┬──▶ child 0  (parses bytes 0..N)
                       ├──▶ child 1  (parses bytes N..2N)
                       └──▶ child 2  ...
                 ▲ all children read ONE SharedBuffer
```

This keeps fan-out logic out of your UI code, and means the host awaits a single
call.

## Step 2: spawn children from inside a worker

Inside a worker, `Worker` is available as a global. Children are created from a
**source string**:

```ts
const CHILD = `
  self.onmessage = function (e) {
    // ...parse...
    self.postMessage({ lines: lines, bytes: bytes /* ... */ });
  };
`;

const child = new Worker({ inline: CHILD });
```

Write child code as ES5-ish plain JS — it is a string, not a compiled module, so
there is no TypeScript and no bundler involved.

Wrap each child in a promise so the coordinator can `Promise.all` them:

```ts
function parseChunk(start: number, end: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = new Worker({ inline: CHILD });
    const timer = setTimeout(() => { child.terminate(); reject(new Error('chunk timed out')); }, 30000);
    child.onmessage = (e: any) => { clearTimeout(timer); child.terminate(); resolve(e.data); };
    child.onerror  = (e: any) => { clearTimeout(timer); child.terminate(); reject(new Error(e.message)); };
    child.postMessage({ name: bufName, capacity, used, start, end });
  });
}
```

Always terminate the child on **all three** paths — success, error and timeout.
A leaked child is a leaked thread.

## Step 3: share the corpus, don't send it

The children receive a buffer **name** and a byte range, never the text:

```ts
const v = new Uint8Array(new SharedBuffer(d.name, d.capacity).arrayBuffer);
```

This is what makes the fan-out cheap. With `postMessage` you would copy 2.6MB per
child — at 8 children, 21MB of cloning to avoid 54ms of parsing.

## Step 4: handle chunk boundaries

Splitting by byte count means chunk edges land mid-line. Each child fixes this
itself, with a rule that provably counts every line exactly once:

```js
// Skip the partial line at the start — it belongs to the previous chunk.
if (i > 0) { while (i < d.used && v[i - 1] !== 10) i++; }
// Finish the line running past the end of this chunk.
while (stop < d.used && v[stop - 1] !== 10) stop++;
```

Each line belongs to the chunk containing its **first** byte: the chunk that
starts inside it skips it, and the chunk that owns it runs past its end to
finish it. No coordination between children required.

## Step 5: reduce

```ts
const total = parts.reduce((a, r) => ({
  lines: a.lines + r.lines,
  ok: a.ok + r.ok,
  missing: a.missing + r.missing,
  error: a.error + r.error,
  max: Math.max(a.max, r.max),
}), { lines: 0, ok: 0, missing: 0, error: 0, max: 0 });
```

Trivial, and that is the point: the expensive part was the scan, which happened
on *n* threads at once. If your reduce is expensive, your split is wrong.

## Step 6: measure with an honest baseline

The screen sweeps 1/2/4/8 workers. Crucially, **n=1 runs the same code path
through one child** — same chunking, same spawn, same messaging. Comparing
against a hand-written single-threaded version would flatter the parallel case by
hiding fan-out overhead.

Measured (iOS simulator): **54ms → 29ms (1.86×) → 17ms (3.18×) → 13ms (4.15×)**.

The tail-off from 4 to 8 is real and worth showing: spawn cost and core count.
Do not hide it.

## Step 7: verify correctness across configurations

Totals must be **identical** for every worker count. The screen prints them:
120,000 lines = 110,810 + 7,059 + 2,131, matching the generator exactly.

This is the check that catches boundary bugs. An off-by-one in the chunk
alignment shows up as a line count that drifts with worker count — invisible if
you only ever run one configuration.

## What to take away

- A coordinator worker keeps fan-out logic out of your UI.
- Children are created from source strings, with `{ inline: ... }`.
- Terminate children on success, error *and* timeout.
- Share the input by name; return only tallies.
- Make each item belong to exactly one chunk by a rule each child applies alone.
- Benchmark n=1 through the same path, and check results are invariant.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=parse yarn start --reset-cache
```

Raise `LINES`, or add 16 to the sweep and watch where the returns stop.

Next: [UIWorker native calls](./uiworker-demo) →
