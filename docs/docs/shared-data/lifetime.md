---
sidebar_position: 6
title: Names & lifetime
---

# Names & lifetime

`SharedStore`, `SharedValue` and `SharedBuffer` are all opened **by name**. That
name is the identity of the data: open `'session'` from the host and from three
workers and you get four handles onto one thing. This page covers what that
implies — who owns the data, when it goes away, and the two mistakes the name
model invites.

## The data is not owned by a runtime

A shared primitive does not belong to the worker that created it. It belongs to
the **process**. That is what makes it shared: it has to outlive any single
runtime, or two workers could never meet on the same value.

Consequences worth internalising:

- Data survives the worker that created it. Terminate the worker, open the name
  again, and the value is still there.
- Data survives a **JS reload**. In development, Fast Refresh and reloads rebuild
  your JS but do not restart the process — so a store you wrote last reload is
  still populated on the next one.
- Nothing is scoped to a screen, a component, or a worker unless you scope it
  yourself.

## Lifetime is reference-counted

Memory is released once **no runtime holds a handle** any more. You do not
release shared data manually in the normal case:

```js
function computeSomething() {
  const scratch = new SharedValue('scratch:' + id, 0);
  // ...use it across a worker...
} // `scratch` becomes unreachable; the cell is freed once it is collected
```

The registry holds **weak** references, so the last handle being released is what
frees the underlying cell, store or buffer. A name with no live handles is not
kept alive by having once existed.

:::caution[Release is eventual, not immediate]
A handle is a JS object, so the native data is released when that object is
**garbage collected** — not when it goes out of scope. Leaving scope only makes
it eligible. If you need release at a known moment — a large buffer, or a name
you are about to re-open at a different size — use `delete()` below rather than
relying on GC timing.
:::

The important corollary: **a name is only alive while somebody holds it.** If the
host drops its handle while a worker still has one, the data stays. If both drop
it and you re-open the name later, you get a *fresh* value — re-seeded from the
`initial` you pass, not the value you last wrote.

## `delete()` — the deliberate-orphan escape hatch

Every primitive has a static `delete(name)`:

```js
SharedValue.delete('progress');
SharedStore.delete('session');
SharedBuffer.delete('pixels');
```

This detaches the name **now**, without waiting for handles to be dropped. It
returns `true` if the name existed.

Use it when you want deterministic release rather than eventual release — most
often for large buffers, or for dynamically named data (per session, per
document, per screen) where names would otherwise accumulate.

Understand what "detach" means, because it is not the same as freeing:

- Handles opened **before** the delete keep working. They are not invalidated —
  they now refer to an orphan that nothing else can reach.
- The next `new SharedValue(name, initial)` creates a **fresh** one. The old
  handles do not observe it, and it does not observe them. You now have two
  unrelated things wearing one name.
- For `SharedStore`, existing subscribers are **not** unsubscribed. They simply
  stop hearing from anyone.
- For `SharedBuffer`, re-opening allocates fresh memory whose `byteLength` is
  fixed by that new first opener.

So delete a name when you are finished with it **everywhere, including in
workers** — not as a way to reset a value that is still in use. To reset, write
to it (`store.batch(...)` a set of clearing writes) rather than deleting it.

## Pitfall 1: stale state across reloads

This is the one that bites in development. A fixed name plus a process that
outlives your JS means the previous run's data is waiting for you:

```js
// Every reload re-opens the SAME store, with whatever the last run left in it.
const store = new SharedStore('notes');
```

Worse, if a previous run's worker was never terminated, its **subscribers are
still attached** and still reacting to writes — so you can see notification
counts that make no sense, or values changing that nothing in your current code
writes.

Scope the name to whatever owns the data:

```js
// One name per mount. A reload cannot inherit the previous run's state.
const name = 'notes-' + Date.now().toString(36);
const store = new SharedStore(name);
```

and release it when that owner goes away (see `delete()` above). Fixed names are
correct for genuinely app-global state; anything narrower should say so in the
name.

## Pitfall 2: writing before anyone is subscribed

Shared data carries **no history**. A write with no subscriber is applied and
observed by nobody — nothing replays it when a subscriber shows up later.

This makes worker startup a race. A worker is not subscribed until its code has
evaluated, which is well after `new Worker(...)` returns:

```js
// WRONG — the worker is probably not subscribed yet, so it never reacts.
const w = new Worker('./analyse');
store.setIn('doc', ['text'], initialText);
```

Wait for the worker to announce itself first:

```js
const w = new Worker('./analyse');
await w.ready('analyse', 5000);
await w.module('analyse').attach(name); // worker subscribes inside this call
store.setIn('doc', ['text'], initialText); // now it is observed
```

The general rule: **establish subscriptions before producing**. If a value must
be readable regardless of timing, remember that reads are always safe — a late
subscriber can `get()` the current state itself, it just will not be told about
the writes it missed.

## Choosing names

- Namespace by owner: `'upload:' + jobId`, not `'progress'`.
- Include a run/mount discriminator for anything not truly global.
- Keep names stable across the runtimes that must meet on them — the name is the
  only thing they share. Pass it as an argument rather than recomputing it on
  both sides.
