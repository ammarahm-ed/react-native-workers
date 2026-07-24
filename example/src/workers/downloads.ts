// A transfer manager living in a worker, reporting progress through SharedValue.
//
// The interesting part is what is NOT here: there is no `postMessage` per
// progress tick and no event per byte. Each transfer owns two shared cells —
// progress and state — and this worker just writes to them. The host reads the
// same cells synchronously while it renders. At 6 transfers x ~120 writes/sec
// that is thousands of updates a second that never touch the JS thread's queue.
//
// Cells hold NUMBERS on purpose: numeric SharedValues take a lock-free atomic
// path, so a write is a store, not a lock + codec round trip.
declare const SharedValue: any;

// `parent` is provided by the worker prelude. Aliased because TS already has a
// global `parent` from its DOM lib. Worker files share one global scope in the
// typechecker, so the alias name has to be unique per file.
const app: any = (globalThis as any).parent;

/** state codes, kept numeric so the cell stays on the atomic path */
const IDLE = 0;
const RUNNING = 1;
const PAUSED = 2;
const DONE = 3;
const CANCELLED = 4;

type Transfer = {
  id: number;
  progress: any; // SharedValue<number>, 0..1000 permille
  state: any; // SharedValue<number>
  /** permille per tick — a stand-in for a real transfer's byte rate */
  rate: number;
};

let transfers: Transfer[] = [];
let timer: any = null;
let writes = 0;
// The host hands us a per-mount namespace so a reload never inherits the
// previous run's cells. See `reset()` for the matching cleanup.
let ns = '';

function tick() {
  let active = 0;

  for (const t of transfers) {
    if (t.state.value !== RUNNING) continue;
    active++;

    const next = Math.min(1000, t.progress.value + t.rate);
    // A plain synchronous write. No bridge, no serialisation, no listener
    // dispatch unless somebody actually subscribed to this cell.
    t.progress.value = next;
    writes++;

    if (next >= 1000) {
      t.state.value = DONE;
      // State transitions ARE worth a notification — they are rare and the UI
      // wants to react. Progress is not; the UI samples that when it renders.
      app.module('app').onFinished(t.id);
    }
  }

  if (active === 0) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTimer() {
  if (timer === null) timer = setInterval(tick, 8);
}

app.register('downloads', {
  /**
   * Creates `count` transfers and returns the cell names so the host can open
   * the very same cells. Names are the only thing that crosses runtimes.
   */
  create(namespace: string, count: number) {
    ns = namespace;
    transfers = [];
    writes = 0;

    for (let i = 0; i < count; i++) {
      const progressName = `${ns}:${i}:p`;
      const stateName = `${ns}:${i}:s`;
      transfers.push({
        id: i,
        progress: new SharedValue(progressName, 0),
        state: new SharedValue(stateName, IDLE),
        // Varied rates so the bars visibly finish at different times.
        rate: 2 + ((i * 7) % 9),
      });
    }

    return transfers.map((t) => ({
      id: t.id,
      progress: `${ns}:${t.id}:p`,
      state: `${ns}:${t.id}:s`,
    }));
  },

  start(id: number) {
    const t = transfers[id];
    if (!t || t.state.value === DONE) return false;
    t.state.value = RUNNING;
    ensureTimer();
    return true;
  },

  startAll() {
    for (const t of transfers) {
      if (t.state.value !== DONE) t.state.value = RUNNING;
    }
    ensureTimer();
    return transfers.length;
  },

  pause(id: number) {
    const t = transfers[id];
    if (!t || t.state.value !== RUNNING) return false;
    t.state.value = PAUSED;
    return true;
  },

  cancel(id: number) {
    const t = transfers[id];
    if (!t) return false;
    t.state.value = CANCELLED;
    t.progress.value = 0;
    return true;
  },

  /** How many shared writes this worker has performed since `create`. */
  stats() {
    return { writes, transfers: transfers.length };
  },

  /**
   * Drops every cell this run created. Without this the names would outlive the
   * worker — shared cells belong to the process, not to whoever made them.
   */
  reset() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    for (const t of transfers) {
      SharedValue.delete(`${ns}:${t.id}:p`);
      SharedValue.delete(`${ns}:${t.id}:s`);
    }
    transfers = [];
    writes = 0;
    return true;
  },
});
