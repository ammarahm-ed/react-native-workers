// JSModule bridge — a two-way, typed RPC layer between the host runtime and a
// worker runtime, built on top of the existing message channel.
//
// The same endpoint logic runs on BOTH sides (host + worker). Each side can
// register modules the OTHER side calls, and get a typed proxy to call the
// other side's modules. Calls are async (Promise); modules can also emit events.
//
// NOTE: the worker prelude (cpp/bindings/WorkerPrelude.h) contains a hand-written
// JS mirror of `createBridge` — keep the two in sync (wire protocol below).

/** Reserved envelope key; a message with `[BRIDGE]===1` is bridge traffic. */
export const BRIDGE = '__rnwb';

// Wire protocol (all messages also carry `[BRIDGE]: 1`):
//   { k:'hello' }                           a new endpoint attached; re-announce
//   { k:'reg',  mod }                       a module was registered on the sender
//   { k:'call', cid, mod, fn, args }        invoke mod.fn(...args); reply with cid
//   { k:'res',  cid, ok, value | error }    result of a call
//   { k:'evt',  mod, ev, args }             one-way event from a module

export type JSModuleImpl = Record<string, (...args: any[]) => any>;

export interface RemoteExtras {
  /** Subscribe to an event emitted by the remote module. Returns unsubscribe. */
  $on(event: string, cb: (...args: any[]) => void): () => void;
  /** Resolves once the remote module has announced itself (worker loaded it). */
  $ready(timeoutMs?: number): Promise<void>;
}

/** Typed view of a remote module: every method becomes async (returns a Promise).
 * `T` may be an `interface` or a `type` (no index-signature constraint). */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
} & RemoteExtras;

export interface ModuleHandle {
  /** Emit an event to whoever holds the remote proxy for this module. */
  emit(event: string, ...args: any[]): void;
  dispose(): void;
}

export interface BridgeEndpoint {
  /** Feed a received bridge envelope. Returns true if it was handled here. */
  handleIncoming(msg: any): boolean;
  registerModule(name: string, impl: JSModuleImpl): ModuleHandle;
  remote<T>(name: string): Remote<T>;
  ready(name: string, timeoutMs?: number): Promise<void>;
  dispose(): void;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: any;
  /** The promise handed to the caller. Kept so `dispose` can mark it handled. */
  promise: Promise<any>;
  /** `mod.fn()`, for the termination error message. */
  what: string;
};

/** A `ready()` waiter: call it to resolve, `.cancel()` to fail it on teardown. */
type ReadyWaiter = (() => void) & { cancel: () => void };

/**
 * Thrown into calls that were still in flight when the worker was terminated.
 * Distinguishable so callers can ignore just this case:
 * `catch (e) { if (e.code !== 'ERR_WORKER_TERMINATED') throw e }`
 */
export class WorkerTerminatedError extends Error {
  readonly code = 'ERR_WORKER_TERMINATED';
  constructor(what: string) {
    super(`${what} — the worker was terminated before it completed`);
    this.name = 'WorkerTerminatedError';
  }
}

function errToWire(e: any): any {
  return { message: (e && e.message) || String(e), name: e && e.name };
}
function wireToErr(w: any): Error {
  const e = new Error((w && w.message) || 'bridge call failed');
  if (w && w.name) e.name = w.name;
  return e;
}

/**
 * Create a bridge endpoint. `send` delivers a bridge envelope to the other side
 * (host: worker.postMessage; worker: self.postMessage). `opts.now` supplies a
 * monotonic clock only for cid uniqueness — not required.
 */
export function createBridge(send: (msg: any) => void): BridgeEndpoint {
  const modules = new Map<string, JSModuleImpl>();
  const knownRemote = new Set<string>();
  const readyWaiters = new Map<string, ReadyWaiter[]>();
  const pending = new Map<number, Pending>();
  const queuedCalls = new Map<string, any[]>(); // calls for a not-yet-registered local module
  const listeners = new Map<string, Set<(...a: any[]) => void>>(); // `${mod}:${ev}`
  let cidSeq = 1;
  let disposed = false;

  function post(k: string, extra: any): void {
    if (disposed) return;
    send({ [BRIDGE]: 1, k, ...extra });
  }

  // Announce ourselves so the other side re-sends its module registrations. This
  // is what makes a fresh endpoint work against an already-running worker runtime
  // (persistent UIWorker reconnect); on first load it races the worker's own
  // `reg` broadcasts and is harmless either way.
  post('hello', {});

  function resolveReady(name: string): void {
    const ws = readyWaiters.get(name);
    if (ws) {
      readyWaiters.delete(name);
      for (const r of ws) r();
    }
  }

  function ready(name: string, timeoutMs = 15000): Promise<void> {
    if (knownRemote.has(name)) return Promise.resolve();
    let wrapped!: ReadyWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      const arr = readyWaiters.get(name) || [];
      const timer = setTimeout(() => {
        const i = arr.indexOf(wrapped);
        if (i !== -1) arr.splice(i, 1);
        reject(new Error(`module "${name}" not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      wrapped = Object.assign(
        () => {
          clearTimeout(timer);
          resolve();
        },
        {
          cancel() {
            clearTimeout(timer);
            promise.catch(() => {});
            reject(new WorkerTerminatedError(`waiting for module "${name}"`));
          },
        }
      );
      arr.push(wrapped);
      readyWaiters.set(name, arr);
    });
    return promise;
  }

  function invokeLocal(m: any): void {
    const impl = modules.get(m.mod);
    if (!impl) {
      // The other side called a module we haven't registered yet — queue it and
      // flush when it registers (races the worker's own load).
      const q = queuedCalls.get(m.mod) || [];
      q.push(m);
      queuedCalls.set(m.mod, q);
      return;
    }
    const fn = impl[m.fn];
    if (typeof fn !== 'function') {
      if (m.cid != null)
        post('res', {
          cid: m.cid,
          ok: false,
          error: { message: `no method "${m.fn}" on module "${m.mod}"` },
        });
      return;
    }
    Promise.resolve()
      .then(() => fn.apply(impl, m.args || []))
      .then((value) => {
        if (m.cid != null) post('res', { cid: m.cid, ok: true, value });
      })
      .catch((err) => {
        if (m.cid != null)
          post('res', { cid: m.cid, ok: false, error: errToWire(err) });
      });
  }

  function handleIncoming(msg: any): boolean {
    if (!msg || msg[BRIDGE] !== 1) return false;
    switch (msg.k) {
      case 'hello':
        // A newly-attached endpoint (e.g. a UIWorker handle reconnecting to an
        // already-loaded persistent runtime) asked us to re-announce. Without
        // this its `ready()` would hang, because the worker script won't re-run
        // to re-register. Existing endpoints already know these modules, so a
        // repeat `reg` is a harmless no-op there.
        for (const name of modules.keys()) post('reg', { mod: name });
        break;
      case 'reg':
        knownRemote.add(msg.mod);
        resolveReady(msg.mod);
        break;
      case 'call':
        invokeLocal(msg);
        break;
      case 'res': {
        const p = pending.get(msg.cid);
        if (p) {
          pending.delete(msg.cid);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(wireToErr(msg.error));
        }
        break;
      }
      case 'evt': {
        const set = listeners.get(msg.mod + ':' + msg.ev);
        if (set) for (const cb of Array.from(set)) cb(...(msg.args || []));
        break;
      }
    }
    return true;
  }

  function callRemote(
    name: string,
    fn: string,
    args: any[],
    timeoutMs = 15000
  ): Promise<any> {
    let entry!: Pending;
    // The executor runs synchronously, so `entry` is assigned before we return.
    const promise = new Promise((resolve, reject) => {
      const cid = cidSeq++;
      const timer = setTimeout(() => {
        pending.delete(cid);
        reject(
          new Error(`bridge call ${name}.${fn} timed out (${timeoutMs}ms)`)
        );
      }, timeoutMs);
      entry = {
        resolve,
        reject,
        timer,
        promise: null as any,
        what: `${name}.${fn}()`,
      };
      pending.set(cid, entry);
      post('call', { cid, mod: name, fn, args });
    });
    entry.promise = promise;
    return promise;
  }

  function on(
    name: string,
    event: string,
    cb: (...a: any[]) => void
  ): () => void {
    const key = name + ':' + event;
    const set = listeners.get(key) || new Set();
    set.add(cb);
    listeners.set(key, set);
    return () => set.delete(cb);
  }

  function remote<T>(name: string): Remote<T> {
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === '$on') return (ev: string, cb: any) => on(name, ev, cb);
        if (prop === '$ready') return (t?: number) => ready(name, t);
        if (typeof prop !== 'string') return undefined;
        return (...args: any[]) => callRemote(name, prop, args);
      },
    };
    return new Proxy({}, handler) as Remote<T>;
  }

  function registerModule(name: string, impl: JSModuleImpl): ModuleHandle {
    modules.set(name, impl);
    post('reg', { mod: name });
    const q = queuedCalls.get(name);
    if (q) {
      queuedCalls.delete(name);
      for (const m of q) invokeLocal(m);
    }
    return {
      emit: (event: string, ...args: any[]) =>
        post('evt', { mod: name, ev: event, args }),
      dispose: () => modules.delete(name),
    };
  }

  return {
    handleIncoming,
    registerModule,
    remote,
    ready,
    dispose() {
      disposed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        // Attaching our own handler BEFORE rejecting marks the promise handled,
        // so a fire-and-forget call does not surface as an unhandled rejection
        // when the worker is torn down. Callers that did await still receive the
        // rejection — an extra handler does not consume it.
        p.promise.catch(() => {});
        p.reject(new WorkerTerminatedError(p.what));
      }
      pending.clear();
      // Same for anyone blocked in `ready()`: without this their timeout fires
      // long after the worker is gone and rejects with a misleading message.
      for (const ws of readyWaiters.values()) {
        for (const w of ws) w.cancel();
      }
      readyWaiters.clear();
      modules.clear();
      listeners.clear();
    },
  };
}
