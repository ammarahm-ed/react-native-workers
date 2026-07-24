import {
  Worker,
  SharedStore,
  SharedValue,
  SharedBuffer,
  nativeWorkerSelfTest,
} from '@ammarahmed/react-native-workers';

export type Bench = { name: string; detail: string };

declare const globalThis: any;

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

// Post one message and await a single reply.
function roundtrip(
  worker: Worker,
  msg: any,
  transfer: any[] = []
): Promise<any> {
  return new Promise((resolve) => {
    worker.onmessage = (e: any) => resolve(e.data);
    worker.postMessage(msg, transfer);
  });
}

// Pure echo — measures messaging cost only (no compute in the worker).
const ECHO = `self.onmessage = (e) => self.postMessage(e.data);`;

export async function runBenchmarks(): Promise<Bench[]> {
  const out: Bench[] = [];

  // 1. Round-trip latency (small message ping-pong).
  {
    const w = new Worker({ inline: ECHO });
    const N = 500;
    await roundtrip(w, 0); // warm up
    const t0 = now();
    for (let i = 0; i < N; i++) await roundtrip(w, i);
    const dt = now() - t0;
    out.push({
      name: `round-trip x${N}`,
      detail: `${(dt / N).toFixed(3)} ms/msg (${dt.toFixed(0)} ms total)`,
    });
    w.terminate();
  }

  // 2. Large binary payload transfer (the SQLite-blob case) — pure messaging.
  {
    const w = new Worker({ inline: ECHO });
    const size = 8 * 1024 * 1024;
    const buf = new Uint8Array(size);
    await roundtrip(w, new Uint8Array(1024)); // warm up
    const t0 = now();
    const echoed = await roundtrip(w, buf, [buf.buffer]);
    const dt = now() - t0;
    const ok = echoed && echoed.byteLength === size;
    out.push({
      name: '8MB Uint8Array transfer',
      detail: `${dt.toFixed(1)} ms (${((size / 1e6 / dt) * 1000).toFixed(0)} MB/s${ok ? '' : ', MISMATCH'})`,
    });
    w.terminate();
  }

  // 3. Large structured object (50k-number array) — the flat-codec win case.
  {
    const w = new Worker({ inline: ECHO });
    const arr = new Array(50000);
    for (let i = 0; i < arr.length; i++) arr[i] = i;
    await roundtrip(w, [1, 2, 3]); // warm up
    const t0 = now();
    const echoed = await roundtrip(w, arr);
    const dt = now() - t0;
    out.push({
      name: '50k-element array clone',
      detail: `${dt.toFixed(1)} ms (len=${echoed?.length})`,
    });
    w.terminate();
  }

  // 5. SharedStore host-side set/get throughput (synchronous C++ ops, no
  //    worker involved — measures the mutex + structured-clone codec cost).
  {
    const store = new SharedStore('bench-throughput');
    const N = 5000;
    const value = { id: 0, name: 'row', active: true, score: 3.14 };
    store.set('warm', value); // warm up
    const t0 = now();
    for (let i = 0; i < N; i++) {
      value.id = i;
      store.set('k', value);
      store.get('k');
    }
    const dt = now() - t0;
    out.push({
      name: `shared-store set+get x${N}`,
      detail: `${((dt / N) * 1000).toFixed(2)} µs/op (${dt.toFixed(0)} ms total)`,
    });
    store.delete('k');
    store.delete('warm');
  }

  // 6. SharedStore large-value round-trip — encode a 50k-number array into the
  //    store and read it back (structured-clone in, structured-clone out).
  {
    const store = new SharedStore('bench-large');
    const arr = new Array(50000);
    for (let i = 0; i < arr.length; i++) arr[i] = i;
    store.set('warm', [1, 2, 3]); // warm up
    const t0 = now();
    store.set('big', arr);
    const echoed = store.get('big');
    const dt = now() - t0;
    out.push({
      name: 'shared-store 50k-array set+get',
      detail: `${dt.toFixed(1)} ms (len=${echoed?.length})`,
    });
    store.delete('big');
    store.delete('warm');
  }

  // 7. Cross-worker write → host watcher latency. A worker writes a key N times;
  //    each write fans out an async notification to the host runtime's watcher.
  //    Measures end-to-end propagation, not just the synchronous set.
  {
    const store = new SharedStore('bench-propagate');
    const N = 500;
    let received = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const off = store.watch((key) => {
      if (key === 'tick' && ++received >= N) resolveDone();
    });
    const w = new Worker({
      inline: `
        var s = new SharedStore('bench-propagate');
        self.onmessage = function (e) {
          var n = e.data;
          for (var i = 0; i < n; i++) s.set('tick', i);
          self.postMessage({ wrote: n });
        };
      `,
    });
    let workerMs = 0;
    const workerDone = new Promise<void>((resolve) => {
      w.onmessage = () => {
        workerMs = now() - t0;
        resolve();
      };
    });
    const t0 = now();
    w.postMessage(N);
    await Promise.all([done, workerDone]);
    const dt = now() - t0;
    out.push({
      name: `shared-store worker→host watch x${N}`,
      detail:
        `${(dt / N).toFixed(3)} ms/event end-to-end ` +
        `(worker writes ${workerMs.toFixed(0)} ms, ${received} delivered)`,
    });
    off();
    w.terminate();
  }

  // 8. Contended writes — several workers hammer the same key concurrently. The
  //    store must serialize every write; this measures the mutex under load and
  //    confirms nothing is lost/corrupted (last-writer-wins on the counter key).
  {
    const store = new SharedStore('bench-contend');
    const WORKERS = 4;
    const PER = 1000;
    store.set('shared', 0);
    const code = `
      var s = new SharedStore('bench-contend');
      self.onmessage = function (e) {
        var per = e.data;
        for (var i = 0; i < per; i++) {
          var cur = s.get('shared') | 0;
          s.set('shared', cur + 1);
        }
        self.postMessage({ done: true });
      };
    `;
    const workers = Array.from(
      { length: WORKERS },
      () => new Worker({ inline: code })
    );
    const t0 = now();
    await Promise.all(workers.map((w) => roundtrip(w, PER)));
    const dt = now() - t0;
    const totalOps = WORKERS * PER * 2; // one get + one set per iteration
    out.push({
      name: `shared-store contended (${WORKERS} workers x${PER})`,
      detail:
        `${dt.toFixed(0)} ms, ${((totalOps / dt) * 1000).toFixed(0)} ops/s ` +
        `(final=${store.get('shared')})`,
    });
    workers.forEach((w) => w.terminate());
    store.delete('shared');
  }

  // 9. Head-to-head: deliver the SAME payload host→worker N times, once over
  //    postMessage and once over SharedStore, and report the ratio. Messaging is
  //    a single structured-clone (host→worker); SharedStore is two (host→store on
  //    set, store→worker on watch-deliver), so this quantifies that trade-off —
  //    plus SharedStore keeps the value queryable by every runtime afterwards.
  {
    // Messaging: post the payload N times, worker touches it, then acks once.
    const deliverByMessaging = async (
      payload: any,
      N: number
    ): Promise<number> => {
      const w = new Worker({
        inline: `
          self.onmessage = function (e) {
            if (e.data === '__warm') { self.postMessage('warm'); return; }
            if (e.data === '__end') { self.postMessage('done'); return; }
            globalThis.__sink = (e.data && e.data.length) | 0; // force decode
          };
        `,
      });
      await roundtrip(w, '__warm'); // warm up (worker replies)
      const done = new Promise<void>((r) => (w.onmessage = () => r()));
      const t0 = now();
      for (let i = 0; i < N; i++) w.postMessage(payload);
      w.postMessage('__end'); // FIFO — arrives after all payloads are processed
      await done;
      const dt = now() - t0;
      w.terminate();
      return dt;
    };

    // SharedStore: set the key N times; the worker's watcher decodes each value
    // and acks once it has seen them all. Pure store transport (no postMessage
    // carries the payload — only a tiny count signal).
    const deliverByStore = async (payload: any, N: number): Promise<number> => {
      const store = new SharedStore('bench-vs');
      const w = new Worker({
        inline: `
          var s = new SharedStore('bench-vs');
          var seen = 0, target = 0;
          function maybeDone() { if (target && seen >= target) self.postMessage('done'); }
          self.onmessage = function (e) { target = e.data; maybeDone(); };
          s.subscribe('payload', function (k, v) {
            globalThis.__sink = (v && v.length) | 0; // force decode
            seen++;
            maybeDone();
          });
        `,
      });
      await new Promise<void>((r) => setTimeout(r, 60)); // let the subscribe land
      const done = new Promise<void>((r) => (w.onmessage = () => r()));
      w.postMessage(N); // tell the worker how many to expect
      const t0 = now();
      for (let i = 0; i < N; i++) store.set('payload', payload);
      await done;
      const dt = now() - t0;
      store.delete('payload');
      w.terminate();
      return dt;
    };

    const withTimeout = (p: Promise<number>, ms: number): Promise<number> =>
      Promise.race([
        p,
        new Promise<number>((r) => setTimeout(() => r(-1), ms)),
      ]);

    const compare = async (label: string, payload: any, N: number) => {
      const msg = await withTimeout(deliverByMessaging(payload, N), 8000);
      const st = await withTimeout(deliverByStore(payload, N), 8000);
      if (msg < 0 || st < 0) {
        out.push({
          name: `deliver ${label} x${N}: messaging vs SharedStore`,
          detail:
            `messaging ${msg < 0 ? 'TIMEOUT' : (msg / N).toFixed(3) + ' ms/op'}, ` +
            `SharedStore ${st < 0 ? 'TIMEOUT' : (st / N).toFixed(3) + ' ms/op'}`,
        });
        return;
      }
      const faster = msg <= st ? 'messaging' : 'SharedStore';
      const ratio = (
        Math.max(msg, st) / Math.max(0.001, Math.min(msg, st))
      ).toFixed(1);
      out.push({
        name: `deliver ${label} x${N}: messaging vs SharedStore`,
        detail:
          `messaging ${(msg / N).toFixed(3)} ms/op, ` +
          `SharedStore ${(st / N).toFixed(3)} ms/op ` +
          `→ ${faster} ${ratio}x faster`,
      });
    };

    // Small payload: per-delivery overhead dominates (dispatch/wake cost).
    await compare('small {n}', { n: 1 }, 1000);
    // Large payload: structured-clone cost dominates (store pays it twice).
    const big = new Array(10000);
    for (let i = 0; i < big.length; i++) big[i] = i;
    await compare('10k-array', big, 100);
  }

  // 10. Granular update cost — the whole point of getIn/setIn. Publish N small
  //    changes to a structured state object three ways: messaging (re-sends the
  //    WHOLE state each time), store.set (re-encodes the whole tree), and
  //    store.setIn (encodes one field + copy-on-write of just the spine).
  {
    const state: any = { meta: { title: 'doc', rev: 0 }, items: {} };
    for (let i = 0; i < 200; i++) {
      state.items['f' + i] = { v: i, on: false, label: 'item ' + i };
    }
    const N = 200;
    const store = new SharedStore('bench-granular');
    const w = new Worker({ inline: ECHO });
    await roundtrip(w, [0]); // warm

    // (a) messaging: re-send the whole state every change.
    let t0 = now();
    for (let i = 0; i < N; i++) w.postMessage(state);
    const tMsg = now() - t0;

    // (b) store.set: re-publish the whole state every change.
    store.set('s', state); // warm
    t0 = now();
    for (let i = 0; i < N; i++) store.set('s', state);
    const tSet = now() - t0;

    // (c) store.setIn: change one nested field each time.
    store.set('s', state);
    t0 = now();
    for (let i = 0; i < N; i++) store.setIn('s', ['items', 'f5', 'v'], i);
    const tIn = now() - t0;

    // Confirm the granular write actually landed (and lazy read works).
    const got = store.getIn('s', ['items', 'f5', 'v']);
    w.terminate();
    out.push({
      name: `granular update x${N} (200-field state)`,
      detail:
        `messaging ${(tMsg / N).toFixed(3)} · set ${(tSet / N).toFixed(3)} · ` +
        `setIn ${(tIn / N).toFixed(3)} ms/op → setIn ` +
        `${(tMsg / Math.max(0.001, tIn)).toFixed(0)}× vs messaging` +
        `${got === N - 1 ? '' : ' (BAD ' + got + ')'}`,
    });
  }

  // 11. JSModule bridge — RPC round-trip latency + arg marshalling (a big param
  //    passed by value each call vs by SharedStore reference).
  {
    const store = new SharedStore('bench-bridge');
    const code = `
      var store = new SharedStore('bench-bridge');
      new JSModule('b', {
        echo: function (x) { return x; },
        sumInline: function (arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; },
        sumShared: function (key) { var a = store.get(key); var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
      });
    `;
    const w = new Worker({ inline: code });
    const b: any = w.module('b');
    await w.ready('b', 4000);

    const N = 300;
    await b.echo(0); // warm
    let t0 = now();
    for (let i = 0; i < N; i++) await b.echo(i);
    const tRpc = now() - t0;

    const big = new Array(5000);
    for (let i = 0; i < big.length; i++) big[i] = i;
    const M = 100;
    await b.sumInline([1]); // warm
    t0 = now();
    for (let i = 0; i < M; i++) await b.sumInline(big);
    const tInline = now() - t0;

    store.set('big', big);
    await b.sumShared('big'); // warm
    t0 = now();
    for (let i = 0; i < M; i++) await b.sumShared('big');
    const tShared = now() - t0;

    w.terminate();
    out.push({
      name: `bridge RPC round-trip x${N}`,
      detail: `${(tRpc / N).toFixed(3)} ms/call (${tRpc.toFixed(0)} ms total)`,
    });
    out.push({
      name: `bridge 5k-array param: inline vs SharedStore x${M}`,
      detail:
        `inline ${(tInline / M).toFixed(3)} · shared ${(tShared / M).toFixed(3)} ms/call ` +
        `→ shared ${(tInline / Math.max(0.001, tShared)).toFixed(1)}× vs inline`,
    });
  }

  // 12. SharedValue throughput (the hot-value path) + vs SharedStore.
  {
    const sv = new SharedValue('bench-sv', 0);
    const N = 100000;
    sv.value = 1;
    let t0 = now();
    for (let i = 0; i < N; i++) sv.value = i;
    const tW = now() - t0;
    t0 = now();
    let acc = 0;
    for (let i = 0; i < N; i++) acc += sv.value;
    const tR = now() - t0;
    out.push({
      name: `SharedValue x${N}`,
      detail:
        `write ${((tW / N) * 1000).toFixed(3)} µs · read ${((tR / N) * 1000).toFixed(3)} µs/op ` +
        `(${((N / tW) * 1000).toFixed(0)} writes/s)`,
    });

    // Same single value via SharedStore (key + map + mutex + node) for contrast.
    const M = 50000;
    const store = new SharedStore('bench-sv-cmp');
    store.set('v', 0);
    t0 = now();
    for (let i = 0; i < M; i++) {
      sv.value = i;
      acc += sv.value;
    }
    const tSV = now() - t0;
    t0 = now();
    for (let i = 0; i < M; i++) {
      store.set('v', i);
      store.get('v');
    }
    const tStore = now() - t0;
    if (!Number.isFinite(acc)) throw new Error('nan'); // consume acc (anti-DCE)
    out.push({
      name: `SharedValue vs SharedStore x${M} (set+get)`,
      detail:
        `SharedValue ${((tSV / M) * 1000).toFixed(3)} · SharedStore ${((tStore / M) * 1000).toFixed(3)} µs/op ` +
        `→ SharedValue ${(tStore / Math.max(0.001, tSV)).toFixed(1)}× faster`,
    });
  }

  // 13. SharedBuffer bulk throughput — pure JS over shared memory, no host calls
  //     per element, vs the same data through SharedStore.
  {
    const N = 50000;
    const buf = new SharedBuffer(
      'bench-buf',
      N * Float64Array.BYTES_PER_ELEMENT
    );
    const f = new Float64Array(buf.arrayBuffer);
    let t0 = now();
    for (let i = 0; i < N; i++) f[i] = i * 1.5;
    let s = 0;
    for (let i = 0; i < N; i++) s += f[i]!;
    const tBuf = now() - t0;

    const store = new SharedStore('bench-buf-store');
    const arr = new Array(N);
    for (let i = 0; i < N; i++) arr[i] = i * 1.5;
    t0 = now();
    store.set('a', arr);
    const got = store.get('a');
    let s2 = 0;
    for (let i = 0; i < N; i++) s2 += got[i]!;
    const tStore = now() - t0;
    out.push({
      name: `bulk ${N} f64: SharedBuffer vs SharedStore`,
      detail:
        `buffer ${tBuf.toFixed(1)} ms · store ${tStore.toFixed(1)} ms ` +
        `→ buffer ${(tStore / Math.max(0.001, tBuf)).toFixed(1)}× faster` +
        `${s === s2 ? '' : ' (MISMATCH)'}`,
    });
  }

  // 14. batch throughput — many setIn with a watcher subscribed: unbatched fires
  //     N notifications, batched fires 1.
  {
    const store = new SharedStore('bench-batch');
    store.set('s', {});
    const off = store.subscribe('s', () => {});
    const N = 5000;
    let t0 = now();
    for (let i = 0; i < N; i++) store.setIn('s', ['k' + (i % 100)], i);
    const tUnbatched = now() - t0;
    t0 = now();
    store.batch(() => {
      for (let i = 0; i < N; i++) store.setIn('s', ['k' + (i % 100)], i);
    });
    const tBatched = now() - t0;
    off();
    out.push({
      name: `batch x${N} setIn (1 watcher)`,
      detail:
        `unbatched ${((tUnbatched / N) * 1000).toFixed(2)} µs/op (${N} notifies) · ` +
        `batched ${((tBatched / N) * 1000).toFixed(2)} µs/op (1 notify)`,
    });
  }

  // 15. Native (UI-thread) worker self-test.
  try {
    const t0 = now();
    const reply = await nativeWorkerSelfTest();
    const dt = now() - t0;
    out.push({
      name: 'native worker self-test',
      detail: `${dt.toFixed(1)} ms → ${reply}`,
    });
  } catch (e) {
    out.push({
      name: 'native worker self-test',
      detail: 'ERROR: ' + String(e),
    });
  }

  return out;
}
