// A sensor sampler writing into a lock-free-ish ring buffer.
//
// This is the case SharedBuffer exists for: a producer running at a rate the UI
// does not control, and a consumer that wants a consistent recent window
// whenever it happens to draw. The samples never cross runtimes — the host reads
// the same memory this worker writes.
//
// Layout of the shared block (all Float32 for a single uniform view):
//   [0]        write cursor (monotonic sample count)
//   [1]        samples per second the producer is achieving
//   [2..2+N)   the ring itself
//
// The cursor and the ring are written together under `withLock`, because a
// reader that saw a new cursor but old samples would draw a torn window. That
// is the entire reason this example locks and the transfer manager does not.
export {};

declare const SharedBuffer: any;

const app: any = (globalThis as any).parent;

const HEADER = 2;

let buf: any = null;
let view: Float32Array | null = null;
let capacity = 0;
let timer: any = null;
let cursor = 0;
let t = 0;
let rateWindowStart = 0;
let rateWindowCount = 0;
// Simulated signal: a couple of sines plus noise, so the waveform has shape.
let noise = 0.12;

app.register('sensor', {
  attach(name: string, cap: number) {
    capacity = cap;
    buf = new SharedBuffer(name, (HEADER + cap) * 4);
    view = new Float32Array(buf.arrayBuffer);
    cursor = 0;
    t = 0;
    return { bytes: (HEADER + cap) * 4, capacity };
  },

  /** Start producing `hz` samples per second. */
  start(hz: number) {
    if (timer !== null) clearInterval(timer);
    const periodMs = Math.max(1, Math.round(1000 / hz));
    // How many samples to emit per timer tick — above ~200Hz a timer per sample
    // is not achievable, so each tick produces a small burst instead.
    const perTick = Math.max(1, Math.round(hz / (1000 / periodMs)));
    rateWindowStart = Date.now();
    rateWindowCount = 0;

    timer = setInterval(() => {
      const v = view!;
      // ONE critical section per burst: cursor and samples move together, so a
      // reader either sees the whole burst or none of it.
      buf.withLock(() => {
        for (let i = 0; i < perTick; i++) {
          t += 1 / 60;
          const sample =
            Math.sin(t * 2.0) * 0.6 +
            Math.sin(t * 7.3) * 0.25 +
            (Math.random() - 0.5) * noise;
          v[HEADER + (cursor % capacity)] = sample;
          cursor++;
        }
        v[0] = cursor;
      });

      rateWindowCount += perTick;
      const elapsed = Date.now() - rateWindowStart;
      if (elapsed >= 500) {
        view![1] = (rateWindowCount * 1000) / elapsed;
        rateWindowStart = Date.now();
        rateWindowCount = 0;
      }
    }, periodMs);

    return { hz, periodMs, perTick };
  },

  stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (view) view[1] = 0;
    return true;
  },

  setNoise(n: number) {
    noise = n;
    return noise;
  },

  dispose(name: string) {
    if (timer !== null) clearInterval(timer);
    timer = null;
    view = null;
    buf = null;
    SharedBuffer.delete(name);
    return true;
  },
});
