---
slug: alpha-3
title: '1.0.0-alpha.3: real native-module isolation, zero-copy transfer, and a comparison page I had wrong'
authors: [ammar]
tags: [release, alpha, expo, isolation]
---

`1.0.0-alpha.3` is the release where a public critique turned into a work item.

Someone from the Worklets team read my comparison page and pointed out, politely
and correctly, that one of its central claims did not hold: native modules in a
worker were not as isolated as I implied. A worker's HTTP response still landed on
the React Native JS thread. If that thread was busy, your worker waited — which is
the exact problem a worker is supposed to solve.

He was right. This release is mostly what it took to make that claim true, plus the
zero-copy binary transfer he'd separately called out as missing, plus a new
[Hacks & compatibility seams](/docs/compat-seams) page that writes down every place
I'm leaning on private internals and what upstream change would let me delete it.

{/* truncate */}

## The correction

[Tomasz Żelawski's thread](https://x.com/tjzeldev/status/2081673853831430226)
made the argument concretely: React Native's native modules are tied to the main RN
runtime, all their events are emitted on it, so `react-native-workers` must be
forwarding those events into worker runtimes and copying the payloads. A request
sent from a worker completes on the JS thread. Modules generally aren't thread-safe
either, because nothing ever asked them to be.

That was an accurate description of what the library did.

The easy response would have been to soften the wording on the comparison page. What
I actually wanted was for a worker not to depend on the RN JS thread at all, and for
a worker's native modules — their events, their instances — to stay on that worker.
That turned out to be a different fix on each platform.

## What changed on Android

Three things, each of which was a real dependency on the host.

**Device events.** `ReactContext.emitDeviceEvent` resolves an emitter through
`getJSModule`, and a worker was getting the host's. Every event a worker module
raised — including every chunk of an HTTP response — was dispatched on the host
runtime and then copied back out. A worker now serves its own emitter, and events
are marshalled straight into that worker's `global.__rctDeviceEventEmitter`. The
host runtime is never involved and nothing is copied through it.

**Module method bodies.** They ran inline on the worker's JS thread, so a module
doing blocking work stalled that worker's event loop — the same starvation shape,
just relocated. Each worker now has its own native-modules queue thread, which is
what React Native does on the host; running them on the JS thread was the anomaly.

**Peer modules.** A module asking the context for another module was handed the
*host's* instance — a live object bound to the host runtime and shared with the main
app. Peer lookups now resolve through the worker's own registry.

## What changed on iOS

The same event routing, through `RCTCallableJSModules` — a worker's modules emit
into that worker's emitter.

Fixing that surfaced something worse, which is worth stating plainly:
**XHR and `fetch` had never worked inside an iOS worker.** `RCTNetworking` gets its
URL handlers through an injected provider and otherwise falls back to `self.bridge`
— and bridgeless has no bridge. The host app never notices because RN's own setup
injects the provider on its behalf; my worker built the module plainly and got an
empty handler list. Every request failed with *"No suitable URL request handler
found"*. It survived this long because the tests covering it had only ever run on
Android.

`RCTImageLoader` had the identical defect, and underneath it a third one: it looks
up its peer `Networking` module through `moduleRegistry`, which a worker answered
with `nil`. That is the same lookup any third-party module uses to find another, so
it was quietly breaking more than images.

## The claim is now a test, not a sentence

The lesson I keep re-learning is that a verified claim and a verified *belief* look
identical until something forces the difference. The old claim was a sentence on a
docs page; there was nothing that would have told me it stopped being true. So this
time it's covered by tests that fail if I break it:

- one pins the host JS thread in a busy loop and requires a worker's HTTP request to
  complete anyway;
- one watches the host's device-event stream during a worker's request and requires
  that none of *that request's* events were dispatched on the host runtime — matched
  by response URL and request id, because simply counting events picks up Metro's own
  traffic and fails for the wrong reason;
- one measures the synchronous window of a native call inside a worker, to prove the
  method body isn't running on the worker's JS thread;
- one terminates 24 workers that are each mid-native-call, then creates a fresh
  worker to prove the host survived it.

## Zero-copy transfer

The other thing the thread called out: Worklets postponed transferable
`ArrayBuffer`s after hitting threading and GC issues in Hermes, and wondered whether
I'd got it right.

Partly. Here is exactly what exists, including the part that isn't real:

`postMessage(value, [buffer])` genuinely moves the backing store rather than copying
it. `createTransferableBuffer(n)` returns an `ArrayBuffer` that is zero-copy on
every hop in both directions — necessary because Hermes only surrenders the store of
an *external* buffer, so a plain `new ArrayBuffer(n)` still costs one copy on the
first hop.

What is **not** real is the detach. Hermes has no `ArrayBuffer` detach and does not
export one, so a transferred buffer cannot be neutered by the engine. The library
enforces what it can: the message path refuses to clone or re-transfer a buffer you
already gave away, and `.detached` reports `true`. But raw reads on the sending side
still succeed, and racing the receiver that way is a data race.
`enableTransferGuard()` makes stale access throw — it's opt-in because it patches
global constructors, which breaks `value.constructor === Uint8Array` and taxes every
view construction.

Structured clone also learned `Map`, `Set`, `RegExp`, `Error` and `BigInt` this
cycle.

## Being honest about the seams

Running a second runtime inside an app whose native layer assumes exactly one means
leaning on internals. The new [Hacks & compatibility seams](/docs/compat-seams) page
lists each one with what it costs you and what upstream change would remove it —
the reflective device-emitter proxy (RN moved the interface between 0.85 and 0.86),
the worker-local `ReactContext`, the version-selected Kotlin source sets, the
reflection into Expo's installer, the hand-built `RCTNetworking` and
`RCTImageLoader`.

If you maintain React Native, Hermes or Expo, the last line of each section is the
ask. Most of them come down to one thing: a supported way to bind a module registry,
an event target, or a JSI installer to a runtime that isn't the app's main one.

## Also in this release

- **Expo SDK 55, 56 and 57 build again on iOS.** The per-worker `AppContext` added
  last cycle was only ever verified against SDK 54, which is what my Expo example
  pins — it did not compile on any other SDK, so those apps couldn't build the
  library at all. Found by the compat matrix, which had not been run against that
  code.
- **RN 0.87** gets a worker-bound `RuntimeExecutor` instead of `null`.
- **Teardown fixes**: a use-after-free in the native queue's self-destruct path, and
  ordering fixes so a module's cleanup work isn't silently dropped.
- **The compat matrix now covers RN 0.81/0.82 on iOS** with a current Xcode, by
  patching the vendored `fmt`'s `consteval` check in the *test scaffold*. Those two
  versions had been unbuildable on modern toolchains and therefore unverified — the
  oldest supported versions being the blind spot is precisely backwards. This does
  not change anything for your app: on RN 0.81/0.82 you still need Xcode ≤ 26.1.

Verified before release: Android 107/107 and iOS 105/105 in the example app's suite
on device, plus 13/13 Android and 13/13 iOS in the compat matrix (RN 0.81–0.86,
`latest`, `next`; Expo 54–57, `latest`).

## Upgrading

```bash
yarn add @ammarahmed/react-native-workers@1.0.0-alpha.3
cd ios && pod install    # or: npx expo prebuild --clean
```

No code changes are needed. `pod install` matters on iOS: the Expo SDK detection and
the worker's networking setup both land at that stage.

## Thank you

Public correction is a gift, and this one was delivered generously — with a list of
things worth praising alongside the things that were wrong, and an offer to
collaborate rather than compete. The comparison page has been
[rewritten](/docs/prior-art#what-the-worklets-team-corrected-me-on) to say what's
actually true, including the parts where Worklets is ahead.

If you find another claim of mine that doesn't hold, please open an issue. I'd
rather be corrected than flattering.
