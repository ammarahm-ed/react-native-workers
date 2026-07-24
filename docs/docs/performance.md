---
sidebar_position: 8
title: Performance
---

# Performance

All numbers below are from the example app's in-app benchmark suite on a **Pixel 5
emulator, debug build**. Release builds and real devices are faster — treat these as
relative guidance, not absolute limits.

## Messaging

| Benchmark | Result |
| --- | --- |
| Message round-trip (500× ping-pong) | **~0.15 ms/msg** |
| 8 MB `Uint8Array` transfer | ~5.5 ms (~1.5 GB/s) |
| 50k-element array clone | ~27 ms |
| C++-created worker round-trip | ~3.6 ms |

Binary payloads are copied at most once and decoded zero-copy, so they move fast.

## Shared data

| Benchmark | Result |
| --- | --- |
| `SharedValue` write / read | **~0.11–0.12 µs/op** → ~8M writes/sec (lock-free) |
| `SharedValue` vs `SharedStore` (single value) | **~3× faster** |
| `SharedBuffer` bulk 50k `Float64Array` vs `SharedStore` | **~6–10× faster** |
| `SharedStore` `set`+`get` round-trip | ~3–6 µs/op |
| `SharedStore` granular `setIn` (200-field object) | **~4× faster** than resending the whole object |

## SharedStore vs messaging

Delivering the same payload host→worker:

- **Small values**: parity with `postMessage`.
- **10k-element array**: roughly even / SharedStore slightly ahead, because inline
  scalar leaves decode without the flat codec.
- **Incremental updates** (change one field of a large object): SharedStore's
  `setIn` is ~4× faster than resending, and independent of the object's size.

## Bridge

| Benchmark | Result |
| --- | --- |
| RPC round-trip | on the order of a `postMessage` round-trip |
| 5k-array argument: inline vs `SharedStore` reference | **~4× faster** by reference |

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
