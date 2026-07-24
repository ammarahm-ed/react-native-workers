// JSModule bridge tests — exercises typed two-way RPC, events, errors, ready
// gating, and SharedStore-backed param marshalling / sync state.
import { Worker, SharedStore } from '@ammarahmed/react-native-workers';

type Result = { name: string; pass: boolean; detail: string };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Typed contract, shared in spirit between worker and parent ----
// (In a real app this lives in a .ts file imported by both sides.)
interface CalcModule {
  add(a: number, b: number): number; // sync impl, called async
  multiply(a: number, b: number): number;
  slow(a: number): Promise<number>; // async impl
  fail(): void; // throws
  addConfigured(a: number): Promise<number>; // calls back into parent
  sumShared(key: string): number; // reads a big param from SharedStore
  sumInline(arr: number[]): number; // same, but arg passed by value
  startProgress(): boolean; // emits 'progress' + 'done' events
}

interface HostModule {
  getConfig(): { base: number };
}

// The worker: registers a `calc` JSModule, calls back into the parent's `host`
// module, reads shared params from a SharedStore, and emits events.
const BRIDGE_WORKER = `
  var store = new SharedStore('bridge-demo');
  var calc = new JSModule('calc', {
    add: function (a, b) { return a + b; },
    multiply: function (a, b) { return a * b; },
    slow: function (a) {
      return new Promise(function (res) { setTimeout(function () { res(a * 10); }, 20); });
    },
    fail: function () { throw new Error('boom'); },
    addConfigured: function (a) {
      return parent.module('host').getConfig().then(function (cfg) { return a + cfg.base; });
    },
    sumShared: function (key) {
      var arr = store.get(key);
      var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i];
      return s;
    },
    sumInline: function (arr) {
      var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i];
      return s;
    },
    startProgress: function () {
      var n = 0;
      var id = setInterval(function () {
        n += 25; calc.emit('progress', { percent: n });
        if (n >= 100) { clearInterval(id); calc.emit('done', { ok: true }); }
      }, 5);
      return true;
    }
  });
  // Worker also expose 'sync state' both sides read instantly via SharedStore.
  store.set('workerState', { status: 'up', ticks: 0 });
  // Listen to a parent-module event and record it (observable from the parent).
  parent.module('host').$on('ping', function (payload) { store.set('lastPing', payload); });
`;

export async function runBridgeTests(): Promise<Result[]> {
  const out: Result[] = [];
  const push = (name: string, pass: boolean, detail: any) =>
    out.push({ name, pass, detail: JSON.stringify(detail) });

  const worker = new Worker({ inline: BRIDGE_WORKER });
  const store = new SharedStore('bridge-demo');

  // Parent registers a module the worker calls back into (two-way).
  const host = worker.registerModule('host', {
    getConfig: () => ({ base: 100 }),
  } satisfies HostModule);

  const calc = worker.module<CalcModule>('calc');

  try {
    // 1. ready gating + basic async call.
    await worker.ready('calc', 4000);
    const sum = await calc.add(2, 3);
    push('bridge async call (parent→worker)', sum === 5, { sum });

    // 2. sync-returning method exposed as async + a genuinely async method.
    const prod = await calc.multiply(4, 5);
    const slow = await calc.slow(3);
    push('bridge sync-return + async methods', prod === 20 && slow === 30, {
      prod,
      slow,
    });

    // 3. error propagation.
    let errMsg = '';
    try {
      await calc.fail();
    } catch (e: any) {
      errMsg = e?.message ?? '';
    }
    push('bridge error propagation', errMsg === 'boom', { errMsg });

    // 4. two-way: worker calls back into the parent's 'host' module.
    const configured = await calc.addConfigured(5);
    push('bridge two-way (worker→parent call)', configured === 105, {
      configured,
    });

    // 5. SharedStore param marshalling: pass a big array by reference (store key)
    //    and read it in the worker; compare with inline-by-value.
    const big = Array.from({ length: 1000 }, (_, i) => i);
    const expected = big.reduce((a, b) => a + b, 0);
    store.set('big', big);
    const viaShared = await calc.sumShared('big');
    const viaInline = await calc.sumInline(big);
    push(
      'bridge SharedStore param + inline param',
      viaShared === expected && viaInline === expected,
      {
        viaShared,
        viaInline,
        expected,
      }
    );

    // 6. sync state via SharedStore (no round-trip).
    const ws = store.get('workerState');
    push('bridge sync state via SharedStore', ws?.status === 'up', { ws });

    // 7. events worker→parent.
    const percents: number[] = [];
    let done = false;
    calc.$on('progress', (p: any) => percents.push(p.percent));
    calc.$on('done', () => {
      done = true;
    });
    await calc.startProgress();
    await delay(160);
    push(
      'bridge events (worker→parent)',
      done && percents.length === 4 && percents[3] === 100,
      {
        percents,
        done,
      }
    );

    // 8. events parent→worker (host emits; worker records via SharedStore).
    host.emit('ping', { hi: 7 });
    await delay(80);
    const lastPing = store.get('lastPing');
    push('bridge events (parent→worker)', lastPing?.hi === 7, { lastPing });
    // 9. terminating with a call in flight. The call must reject — it can never
    //    complete — but with an error the caller can identify, and WITHOUT
    //    surfacing as an unhandled rejection for fire-and-forget callers, which
    //    is what unmounting a screen mid-call looks like.
    {
      const doomed = new Worker({ inline: BRIDGE_WORKER });
      const dm: any = doomed.module('calc');
      await doomed.ready('calc', 5000);

      const inFlight = dm.slow(1); // 20ms; still pending when we terminate
      dm.slow(2); // fire-and-forget: nobody attached a handler
      const pendingReady = doomed.ready('never-registered', 30000);

      doomed.terminate();

      let code = '';
      let name = '';
      try {
        await inFlight;
      } catch (e: any) {
        code = e?.code ?? '';
        name = e?.name ?? '';
      }
      let readyCode = '';
      try {
        await pendingReady;
      } catch (e: any) {
        readyCode = e?.code ?? '';
      }

      push(
        'terminate rejects in-flight calls with ERR_WORKER_TERMINATED',
        code === 'ERR_WORKER_TERMINATED' &&
          name === 'WorkerTerminatedError' &&
          readyCode === 'ERR_WORKER_TERMINATED',
        { code, name, readyCode }
      );
    }
  } catch (err: any) {
    push('bridge harness', false, {
      error: String(err?.stack ?? err?.message ?? err),
    });
  } finally {
    worker.terminate();
  }
  return out;
}
