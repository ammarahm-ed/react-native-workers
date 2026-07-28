---
sidebar_position: 8
title: Performance
---

# Performance

All numbers below are from the example app's in-app benchmark suite in **release
builds**, on two machines:

- **Android** — Pixel 5 emulator (arm64), median of 4 runs.
- **iOS** — iPhone 17 Pro simulator (arm64), single run.

Both are simulators on a development Mac, not phones. Treat these as relative
guidance — the ratios between approaches are the durable part; the absolute
figures move with hardware.

:::caution[Read the latency rows with care]
Repeated runs of the *same* Android build varied by up to ~50% on the round-trip
benchmark (0.068–0.101 ms/msg), so single-figure comparisons across the two
columns are not meaningful at that resolution — hence the medians.

In particular, **the Android↔iOS latency gap is an artefact of the emulator, not
a platform difference.** Worker→host delivery on Android no longer enters the JVM
at all (see below), and removing it moved the round-trip figure by less than the
run-to-run noise. What remains is guest-kernel thread wakeup latency, which a
physical device does not pay.
:::

## Messaging

| Benchmark | Android | iOS |
| --- | --- | --- |
| Message round-trip (500× ping-pong) | **~0.09 ms/msg** | ~0.013 ms/msg |
| 8 MB `Uint8Array` transfer | ~1.8 ms (~5 GB/s) | ~6.9 ms (~1.2 GB/s) |
| 50k-element array clone | ~4.0 ms | ~5.0 ms |
| Native (C++-created) worker self-test | ~10.5 ms | — |

Binary payloads are copied at most once and decoded zero-copy, so they move fast.
Transfer throughput is the benchmark most sensitive to the host machine — the two
columns above differ by ~4×, on the same laptop.

### Cross-thread delivery

Worker→worker messaging never touches the platform: a nested worker gets its own
module instance and hands off through a plain mutex + condition variable on its
own thread.

Worker→**host** is the one hop that used to differ, because the host JS thread is
a Java `Looper` thread and `CallInvoker` posts to it through a Java `MessageQueue`
(a JVM attach and a Java object allocation per message). On Android that hop now
goes through an `eventfd` registered on the host thread's native looper instead,
so a delivery costs one `write()` syscall and never enters Java. iOS was already
free of this — its equivalent posts to a CFRunLoop source.

## Shared data

| Benchmark | Android | iOS |
| --- | --- | --- |
| `SharedValue` write / read | **~0.06 µs/op** → ~17M writes/sec (lock-free) | ~0.06 µs/op |
| `SharedValue` vs `SharedStore` (single value) | **~2.0× faster** | ~1.3× faster |
| `SharedBuffer` bulk 50k `Float64Array` vs `SharedStore` | **~4.2× faster** | ~2.3× faster |
| `SharedStore` `set`+`get` round-trip | ~1.1 µs/op | ~0.92 µs/op |
| `SharedStore` granular `setIn` (200-field object) | **~12× faster** than resending the whole object | ~7× faster |
| `SharedStore` contended (4 workers × 1000) | ~775k ops/s | ~1.1M ops/s |
| `SharedStore.batch` (5000 `setIn`, 1 watcher) | ~6.3 → ~4.8 µs/op | ~7.1 → ~7.0 µs/op |

## SharedStore vs messaging

Delivering the same payload host→worker:

- **Small values**: roughly parity with `postMessage` (SharedStore ~1.3× ahead).
- **10k-element array**: **`postMessage` wins, ~2.6×** (0.25 vs 0.66 ms/op). A
  single large array is exactly the case the flat codec is good at, and
  SharedStore pays per-leaf costs it cannot amortise. Don't reach for SharedStore
  to move one big blob.
- **Incremental updates** (change one field of a large object): SharedStore's
  `setIn` is ~7–12× faster than resending, and independent of the object's size.
  This is the case that actually justifies it.

## Bridge

| Benchmark | Android | iOS |
| --- | --- | --- |
| RPC round-trip | ~0.10 ms/call | ~0.017 ms/call |
| 5k-array argument: inline vs `SharedStore` reference | **~1.3× faster** by reference (0.34 → 0.25 ms/call) | ~1.3× faster |

An RPC round-trip costs about the same as a `postMessage` round-trip — the bridge
adds routing, not a second thread hop.

## How to pick for speed

The single most important rule: **don't copy in the hot path.**

- Per-frame numbers → [`SharedValue`](./shared-data/shared-value) (lock-free reads,
  no thread hop).
- Per-frame arrays / bulk math → [`SharedBuffer`](./shared-data/shared-buffer)
  (plain JS over shared memory — no per-element boundary crossing).
- Frequently-updated structured state → [`SharedStore`](./shared-data/shared-store)
  `setIn` (patch one field, notify once with `batch`).
- Request/response → the [bridge](./rpc/jsmodule-bridge) — but pass large arguments
  by `SharedStore` reference, not by value.
- Never do a bridge/`postMessage` round-trip **per frame** — it's async, copies, and
  hops threads. The synchronous shared primitives are the per-frame path.

## The floor

For a single value, "read a native cell from JS" costs about one JS↔native call —
the same floor any comparable primitive pays (including worklet-style shared
values). To go faster than per-cell, do the whole loop in one runtime over a
`SharedBuffer`; that's the only way to escape per-element boundary crossings.
