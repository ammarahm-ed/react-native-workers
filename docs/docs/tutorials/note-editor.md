---
sidebar_position: 2
title: 2. Note editor (SharedStore)
---

# Building the note editor

**What you’ll build:** a text editor whose word counts, reading time and
debounced autosave are computed in a worker — with **no messages** about the
document at all.

**Why:** RPC is the wrong tool for per-keystroke updates. A call per keystroke is
a round trip per keystroke. Shared state removes the round trip entirely.

Files: `example/src/workers/notes.ts` · `example/src/screens/NotesScreen.tsx`

## Step 1: model it as shared state, not messages

Both sides attach to one store:

```text
host  ──writes──▶  doc.text   ──▶ worker is subscribed, wakes up
worker ─writes──▶  stats      ──▶ host is subscribed, re-renders
```

Nobody sends anything. Each side writes to memory the other is watching. Note
this is a **loop**, and loops need care — see step 5.

## Step 2: name the store per mount

```tsx
// screens/NotesScreen.tsx
const name = 'notes-' + Date.now().toString(36);
const store = new SharedStore(name);
```

It is tempting to write `new SharedStore('notes')`. Don't. Stores are
process-wide: they outlive the worker **and a JS reload**, so a fixed name
inherits whatever the last run left in it — including subscribers belonging to
workers that no longer exist.

The symptom is easy to misread: a counter reporting events nothing sent — "126
notifications received" against an empty editor — because earlier Fast Refresh
generations are still attached to the same store and still reacting to it.

→ [Names & lifetime](../shared-data/lifetime)

## Step 3: subscribe in the worker to a path, not a key

```ts
// workers/notes.ts
store.subscribeIn('doc', ['text'], (_relPath, text) => {
  const stats = analyse(typeof text === 'string' ? text : '');
  store.setIn('stats', ['live'], stats);
});
```

`subscribeIn(key, path, cb)` fires **only** when a change touches that subtree,
and hands you the changed slice rather than the whole document. With
`subscribe('doc', ...)` you would be handed the entire document on every
keystroke and have to diff it yourself.

Correspondingly, the host writes with `setIn`:

```tsx
const onChange = (t: string) => {
  setText(t);
  storeRef.current?.setIn('doc', ['text'], t); // synchronous, no await
};
```

`setIn` rebuilds only the root→path spine and leaves the rest of the stored value
untouched, so writing one field of a large document is cheap.

## Step 4: get the ordering right

This is the bug that broke the first version of this screen, and it is the most
common shared-state mistake:

```tsx
// WRONG — the worker has not evaluated yet, so it is not subscribed.
const w = new Worker('../workers/notes');
store.setIn('doc', ['text'], SAMPLE); // observed by nobody, never replayed
```

Shared data carries **no history**. A write with no subscriber is applied and
silently ignored. Nothing wakes the worker up later.

The fix is to make subscription part of an awaited call:

```tsx
await w.ready('notes', 5000);
await (w.module('notes') as any).attach(name); // worker subscribes inside this
// only now is it safe to produce
setText(SAMPLE);
storeRef.current?.setIn('doc', ['text'], SAMPLE);
```

```ts
// worker
app.register('notes', {
  attach(name: string) {
    store = new SharedStore(name);
    unsubscribe = store.subscribeIn('doc', ['text'], onDocChanged);
    return true;
  },
});
```

**Rule: establish subscriptions before producing.** Reads are always safe — a
late subscriber can `get()` current state — but it will never be told about
writes it missed.

## Step 5: avoid the feedback loop

The worker writes `stats`; the host is subscribed to `stats`. If the host reacted
to a `stats` change by writing back to `doc`, you would have an infinite loop
across two threads.

The discipline that prevents it: **each side owns its own keys.** The host writes
only `doc`, the worker writes only `stats`. Nobody writes what they subscribe to.

## Step 6: debounce inside the worker

The autosave belongs on the worker's timer, not the host's — that keeps the
policy next to the work:

```ts
if (debounce) clearTimeout(debounce);
debounce = setTimeout(() => {
  saves++;
  store.batch(() => {
    store.setIn('stats', ['saved'], stats);
    store.setIn('stats', ['saves'], saves);
    store.setIn('stats', ['savedAt'], Date.now());
  });
  app.module('app').onSaved(saves); // a real call, because this is rare
}, 400);
```

Two things worth noticing:

- **`batch()`** applies all three writes atomically and notifies watchers
  **once**. Without it the host receives three separate notifications and would
  render three times for one save.
- The save notification goes over the **bridge**, not the store. State changes
  that are rare and meaningful are worth a real call; per-keystroke updates are
  not.

## Step 7: prove the claim on screen

Rather than asserting "batch coalesces", the screen counts:

```tsx
store.subscribe('stats', () => setNotifications((n) => n + 1));
```

Sending 36 writes yields **37** notifications: 36 live updates plus exactly one
for the three-field save.

Flip the switch off and the arithmetic changes in the way the claim predicts. A
measured run with batching disabled part-way through: **141 writes → 148
notifications across 3 saves** — 141 live updates, plus 1 for the batched save
and 3 each for the two unbatched ones.

If you write a demo, make it produce a number that would be wrong if the claim
were wrong.

## Step 8: clean up the name

```tsx
return () => {
  if (name) (w.module('notes') as any)?.dispose?.(name);
  w.terminate();
};
```

```ts
dispose(name: string) {
  if (unsubscribe) unsubscribe();
  SharedStore.delete(name);
  return true;
}
```

:::caution
`terminate()` does not drain in-flight calls, so a fire-and-forget `dispose()`
issued immediately before it may not run. It is harmless here — shared data is
reference-counted, so the store is released anyway once the worker dies and the
host drops its handle. `delete()` just makes it deterministic.
:::

## What to take away

- Per-keystroke updates belong in shared state; rare events belong on the bridge.
- `subscribeIn` for paths, `setIn` for writes — never hand around whole documents.
- Subscribe before you produce. There is no history.
- Each side owns its own keys, or you build a cross-thread loop.
- Scope store names, or you inherit the last run's state.

## Try it

```bash
cd example && RN_WORKERS_SCREEN=notes yarn start --reset-cache
```

Toggle `batch()` off and keep typing — watch notifications pull ahead of writes.

Next: [Transfer manager (SharedValue)](./transfer-manager) →
