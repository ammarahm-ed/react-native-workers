// Comprehensive tests for the shared-data primitives + defineModule, exercising
// cross-runtime behaviour (the parts Node can't cover): SharedValue, SharedBuffer
// (true shared memory), SharedStore.batch, reactive state, and a full defineModule
// round-trip between host and worker.
import {
  Worker,
  SharedValue,
  SharedBuffer,
  SharedStore,
  reactive,
  defineModule,
} from '@ammarahmed/react-native-workers';

type Result = { name: string; pass: boolean; detail: string };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A worker exposing a JSModule that pokes the primitives from the OTHER runtime.
const PROBE = `
  new JSModule('probe', {
    svRead: function (name) { return new SharedValue(name).value; },
    svWrite: function (name, v) { new SharedValue(name).value = v; return true; },
    bufRead: function (name, len, idx) { var b = new SharedBuffer(name, len); return new Float64Array(b.arrayBuffer)[idx]; },
    bufWrite: function (name, len, idx, v) { var b = new SharedBuffer(name, len); new Float64Array(b.arrayBuffer)[idx] = v; return true; },
    bufFill: function (name, len, n) { var b = new SharedBuffer(name, len); var f = new Float64Array(b.arrayBuffer); for (var i=0;i<n;i++) f[i]=i*2; return n; },
    rxRead: function (store, path) { return new SharedStore(store).getIn('state', path); },
    rxWrite: function (store, path, v) { new SharedStore(store).setIn('state', path, v); return true; }
  });
`;

export async function runPrimitivesTests(): Promise<Result[]> {
  // Shared cells/buffers/stores live in a PROCESS-wide native registry, so they
  // outlive the JS runtime: a Fast Refresh or dev reload recreates the bundle
  // but not the process. And `new SharedValue(name, initial)` seeds only when
  // the cell is brand new — by design, since two runtimes opening the same name
  // must not clobber each other. Re-running the suite against fixed names
  // therefore reads back whatever the PREVIOUS run left behind: "SharedValue
  // initial" would see 777, written to the 'num' cell by the cross-runtime write test
  // below. Namespace every shared name per run so each run starts clean.
  const NS = 't' + Date.now().toString(36) + '-';
  const out: Result[] = [];
  const push = (name: string, pass: boolean, detail: any) =>
    out.push({ name, pass, detail: JSON.stringify(detail) });

  const worker = new Worker({ inline: PROBE });
  const probe: any = worker.module('probe');
  await worker.ready('probe', 4000).catch(() => {});

  try {
    // ---------- SharedValue ----------
    {
      const sv = new SharedValue(NS + 'num', 5);
      push('SharedValue initial', sv.value === 5, sv.value);
      sv.value = 42;
      push('SharedValue write/read', sv.value === 42, sv.value);
      // types
      const ss = new SharedValue<any>(NS + 'str');
      ss.value = 'hi';
      const sb = new SharedValue<any>(NS + 'bool');
      sb.value = true;
      const so = new SharedValue<any>(NS + 'obj');
      so.value = { a: 1, b: [2, 3] };
      push(
        'SharedValue types (string/bool/object)',
        ss.value === 'hi' && sb.value === true && so.value.b[1] === 3,
        [ss.value, sb.value, so.value]
      );
      // cross-runtime: host wrote 42 to the 'num' cell; worker reads same cell
      const wRead = await probe.svRead(NS + 'num');
      push('SharedValue cross-runtime read (host→worker)', wRead === 42, wRead);
      // worker writes; host reads
      await probe.svWrite(NS + 'num', 777);
      push(
        'SharedValue cross-runtime write (worker→host)',
        sv.value === 777,
        sv.value
      );
      // subscribe: worker write fires host listener
      const sub = new SharedValue(NS + 'sub', 0);
      let got: any = null;
      const off = sub.subscribe((v) => {
        got = v;
      });
      await probe.svWrite(NS + 'sub', 314);
      await delay(60);
      push('SharedValue subscribe (worker→host)', got === 314, got);
      off();
      // after unsubscribe, no more fires
      got = null;
      await probe.svWrite(NS + 'sub', 1);
      await delay(60);
      push('SharedValue unsubscribe', got === null, got);

      // delete: forces the name to be forgotten even while a handle is live, so
      // re-opening is a BRAND NEW cell that re-seeds its initial. `held` is kept
      // in scope on purpose — the cell must still be referenced for `delete` to
      // report that it was live.
      const delName = NS + 'del';
      const held = new SharedValue(delName, 1);
      held.value = 99;
      const wasLive = SharedValue.delete(delName);
      const again = SharedValue.delete(delName); // already forgotten
      const reopened = new SharedValue(delName, 7);
      push(
        'SharedValue delete releases the name',
        wasLive === true && again === false && reopened.value === 7,
        { wasLive, again, reopened: reopened.value }
      );
      // The old handle still works — it just points at an orphaned cell nobody
      // else can reach, so writes through it are invisible to the new one.
      held.value = 1234;
      push(
        'SharedValue delete detaches the old handle',
        held.value === 1234 && reopened.value === 7,
        { held: held.value, reopened: reopened.value }
      );
      // ...and the worker, a different runtime, sees the new cell.
      const wSees = await probe.svRead(delName);
      push('SharedValue delete visible cross-runtime', wSees === 7, wSees);

      // Refcounting: a cell referenced by nothing is freed automatically, so the
      // name goes stale and re-opening re-seeds. No delete() call involved.
      const gcName = NS + 'gc';
      (() => {
        const tmp = new SharedValue(gcName, 1);
        tmp.value = 555; // handle dies with this scope
      })();
      (globalThis as any).__rnworkersCollectGarbage();
      const afterGc = new SharedValue(gcName, 7).value;
      push('SharedValue freed when unreferenced', afterGc === 7, afterGc);

      // ...but a cell someone still holds must SURVIVE a collection.
      const keptName = NS + 'kept';
      const kept = new SharedValue(keptName, 1);
      kept.value = 555;
      (globalThis as any).__rnworkersCollectGarbage();
      const stillThere = new SharedValue(keptName, 7).value;
      push(
        'SharedValue survives GC while referenced',
        stillThere === 555 && kept.value === 555,
        { stillThere, kept: kept.value }
      );
    }

    // ---------- SharedBuffer (true shared memory) ----------
    {
      const LEN = 8 * Float64Array.BYTES_PER_ELEMENT;
      const buf = new SharedBuffer(NS + 'buf', LEN);
      const f = new Float64Array(buf.arrayBuffer);
      push('SharedBuffer byteLength', buf.byteLength === LEN, buf.byteLength);
      f[0] = 1.5;
      f[1] = 2.5;
      f[2] = 3.5;
      // worker reads the SAME memory
      const wv = await probe.bufRead(NS + 'buf', LEN, 2);
      push(
        'SharedBuffer shared read (host write → worker read)',
        wv === 3.5,
        wv
      );
      // worker writes; host reads same bytes
      await probe.bufWrite(NS + 'buf', LEN, 3, 99.25);
      push(
        'SharedBuffer shared write (worker write → host read)',
        f[3] === 99.25,
        f[3]
      );
      // multiple views over the same buffer alias
      const u8 = new Uint8Array(buf.arrayBuffer);
      const f2 = new Float64Array(buf.arrayBuffer);
      f2[4] = 12345.678;
      push(
        'SharedBuffer aliasing views',
        u8.length === LEN && f[4] === 12345.678,
        [u8.length, f[4]]
      );
      // worker fills many; host sees them
      await probe.bufFill(NS + 'buf', LEN, 8);
      push('SharedBuffer bulk fill visible', f[5] === 10 && f[7] === 14, [
        f[5],
        f[7],
      ]);
      // withLock returns fn result, no deadlock
      f[0] = 1.5;
      f[1] = 2.5;
      const locked = buf.withLock(() => f[0]! + f[1]!);
      push('SharedBuffer withLock', locked === 4.0, locked);

      // Refcounting. The owner of the memory is the ArrayBuffer itself, so the
      // wrapper AND every typed-array view over it must go before it is freed.
      const gcBuf = NS + 'gcbuf';
      (() => {
        const b = new SharedBuffer(gcBuf, LEN);
        new Float64Array(b.arrayBuffer)[0] = 555;
      })();
      (globalThis as any).__rnworkersCollectGarbage();
      const freshBuf = new SharedBuffer(gcBuf, LEN);
      push(
        'SharedBuffer freed when unreferenced',
        new Float64Array(freshBuf.arrayBuffer)[0] === 0,
        new Float64Array(freshBuf.arrayBuffer)[0]
      );
      // A freed name is also free to come back at a DIFFERENT length — the size
      // is fixed by the first *live* opener, not by the name for all time.
      const relen = NS + 'relen';
      (() => {
        // eslint-disable-next-line no-new
        new SharedBuffer(relen, 64);
      })();
      (globalThis as any).__rnworkersCollectGarbage();
      const wider = new SharedBuffer(relen, 256);
      push('SharedBuffer name reusable at new size', wider.byteLength === 256, {
        byteLength: wider.byteLength,
      });

      // ...and a referenced buffer must SURVIVE a collection, with its bytes.
      const keptBuf = new SharedBuffer(NS + 'keptbuf', LEN);
      new Float64Array(keptBuf.arrayBuffer)[0] = 555;
      (globalThis as any).__rnworkersCollectGarbage();
      const sameBuf = new SharedBuffer(NS + 'keptbuf', LEN);
      const sameView = new Float64Array(sameBuf.arrayBuffer);
      // Still the SAME memory: a write through the new view is seen by the old.
      sameView[1] = 77;
      push(
        'SharedBuffer survives GC while referenced',
        sameView[0] === 555 && new Float64Array(keptBuf.arrayBuffer)[1] === 77,
        {
          first: sameView[0],
          aliased: new Float64Array(keptBuf.arrayBuffer)[1],
        }
      );

      // Smoke test for the lock now living inside SharedMem: nesting one handle's
      // critical section inside another's still works and returns the inner
      // result. NB this does NOT prove the two handles share a mutex — on one
      // thread that succeeds either way (recursively if same, trivially if not).
      // Proving identity needs real cross-thread contention; see the comment on
      // openLock in SharedBuffer.cpp for why the aliasing shared_ptr guarantees
      // it by construction instead.
      const reentered = keptBuf.withLock(() => sameBuf.withLock(() => 42));
      push('SharedBuffer nested withLock across handles', reentered === 42, {
        reentered,
      });
    }

    // ---------- SharedStore.batch ----------
    {
      const store = new SharedStore(NS + 'batch');
      store.set('state', { a: 0, b: 0, c: 0 });
      let fires = 0;
      let last: any = null;
      const off = store.subscribe('state', (_k, v) => {
        fires++;
        last = v;
      });
      store.batch(() => {
        store.setIn('state', ['a'], 1);
        store.setIn('state', ['b'], 2);
        store.setIn('state', ['c'], 3);
        // reads are consistent INSIDE the batch
      });
      const insideConsistent = store.getIn('state', ['a']) === 1;
      await delay(60);
      push(
        'SharedStore.batch coalesces notifications',
        fires === 1 && insideConsistent && last?.a === 1 && last?.c === 3,
        { fires, insideConsistent, last }
      );
      off();
      // nested batch → still one flush
      let fires2 = 0;
      const off2 = store.subscribe('state', () => {
        fires2++;
      });
      store.batch(() => {
        store.setIn('state', ['a'], 10);
        store.batch(() => {
          store.setIn('state', ['b'], 20);
        });
      });
      await delay(60);
      push('SharedStore.batch nested', fires2 === 1, fires2);
      off2();
    }

    // ---------- lifetime: SharedStore is refcounted too ----------
    {
      // Dropped store → freed → the name comes back empty.
      const gcStore = NS + 'gcstore';
      (() => {
        new SharedStore(gcStore).set('state', { a: 555 });
      })();
      (globalThis as any).__rnworkersCollectGarbage();
      const afterGc = new SharedStore(gcStore).get('state');
      push('SharedStore freed when unreferenced', afterGc === undefined, {
        afterGc,
      });

      // Referenced store keeps its contents across a collection.
      const keptStore = new SharedStore(NS + 'keptstore');
      keptStore.set('state', { a: 555 });
      (globalThis as any).__rnworkersCollectGarbage();
      const stillThere: any = new SharedStore(NS + 'keptstore').get('state');
      push('SharedStore survives GC while referenced', stillThere?.a === 555, {
        stillThere,
      });

      // A live SUBSCRIPTION is ownership on its own: the store must survive even
      // though no handle is retained anywhere, and must still deliver. This is
      // the case that would silently break if only handles counted.
      const subStore = NS + 'substore';
      let heard: any = null;
      const off = new SharedStore(subStore).subscribe('state', (_k, v) => {
        heard = v;
      });
      (globalThis as any).__rnworkersCollectGarbage();
      new SharedStore(subStore).set('state', { a: 7 });
      await delay(60);
      push('SharedStore kept alive by a subscription', heard?.a === 7, {
        heard,
      });
      off();
    }

    // ---------- reactive (cross-runtime) ----------
    {
      const store = new SharedStore(NS + 'rx');
      const state: any = reactive(store, 'state');
      state.user = { name: 'Ada', tags: ['x'] };
      state.count = 1;
      await delay(20); // let the batched write flush
      // worker reads via getIn
      const wName = await probe.rxRead(NS + 'rx', ['user', 'name']);
      push('reactive host write → worker read', wName === 'Ada', wName);
      // worker writes; host reactive reads it
      await probe.rxWrite(NS + 'rx', ['count'], 5);
      push('reactive worker write → host read', state.count === 5, state.count);
      // array through reactive
      state.user.tags.push('y');
      await delay(20);
      const tags = await probe.rxRead(NS + 'rx', ['user', 'tags']);
      push(
        'reactive array push cross-runtime',
        tags?.length === 2 && tags[1] === 'y',
        tags
      );
    }

    // ---------- defineModule full round-trip ----------
    {
      const counter = defineModule<{
        worker: { inc(by: number): number; total(): number };
        host: { seed(): number };
        events: { ticked: { n: number } };
        state: { total: number };
      }>('counter');

      const CODE = `
        var c = defineModule('counter');
        var api = c.worker({
          inc: function (by) {
            c.__api = api;
            api.state.total = (api.state.total || 0) + by;
            api.emit('ticked', { n: api.state.total });
            return api.state.total;
          },
          total: function () { return api.state.total || 0; }
        });
        // pull the seed from the host on startup
        api.host.seed().then(function (s) { api.state.total = s; });
      `;
      const w2 = new Worker({ inline: CODE });
      const c = counter.host(w2, { seed: () => 100 });
      await c.$ready(4000);
      await delay(60); // let seed() resolve on the worker
      const ticks: number[] = [];
      c.on('ticked', (p) => ticks.push(p.n));
      const after1 = await c.inc(5);
      const after2 = await c.inc(3);
      push('defineModule call + state', after1 === 105 && after2 === 108, [
        after1,
        after2,
      ]);
      push(
        'defineModule host reads shared state',
        c.state.total === 108,
        c.state.total
      );
      await delay(40);
      push(
        'defineModule events worker→host',
        ticks.length === 2 && ticks[1] === 108,
        ticks
      );
      const total = await c.total();
      push('defineModule two-way seed (host→worker)', total === 108, total);
      w2.terminate();
    }
  } catch (err: any) {
    push('primitives harness', false, {
      error: String(err?.stack ?? err?.message ?? err),
    });
  } finally {
    worker.terminate();
  }
  return out;
}
