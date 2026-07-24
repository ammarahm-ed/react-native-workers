// defineModule — one typed contract, both counterparts present. Sugar over the
// low-level bridge (worker.module/registerModule, JSModule/parent) + SharedStore
// reactive state. See docs/jsmodule-defineModule.md.
//
// The host side uses the passed Worker; the worker side uses the worker-runtime
// globals (JSModule/parent/SharedStore). A worker-prelude mirror provides the same
// `defineModule`/`reactive` globals for inline workers (keep them in sync).
import { SharedStore } from './SharedStore';
import { reactive } from './reactive';
import type { StorePath } from './SharedStore';
import type { Remote } from './bridge';

declare const globalThis: any;

type Fns = Record<string, (...a: any[]) => any>;

export interface ModuleContract {
  worker?: Fns;
  host?: Fns;
  events?: Record<string, any>; // worker → host
  hostEvents?: Record<string, any>; // host → worker
  state?: object;
}

type Emitter<E> = <K extends keyof E>(event: K, payload: E[K]) => void;
type On<E> = <K extends keyof E>(
  event: K,
  cb: (payload: E[K]) => void
) => () => void;

export interface WorkerSide<C extends ModuleContract> {
  host: Remote<NonNullable<C['host']>>;
  emit: Emitter<NonNullable<C['events']>>;
  on: On<NonNullable<C['hostEvents']>>;
  state: NonNullable<C['state']>;
  dispose(): void;
}

export type HostSide<C extends ModuleContract> = Remote<
  NonNullable<C['worker']>
> & {
  on: On<NonNullable<C['events']>>;
  emit: Emitter<NonNullable<C['hostEvents']>>;
  state: NonNullable<C['state']>;
  $ready(timeoutMs?: number): Promise<void>;
};

// A structural subset of Worker so this file needn't import the class value.
interface WorkerLike {
  module(name: string): any;
  registerModule(
    name: string,
    impl: Fns
  ): { emit: (e: string, ...a: any[]) => void };
  ready(name: string, timeoutMs?: number): Promise<void>;
}

export interface Module<C extends ModuleContract> {
  readonly name: string;
  /** Implement the worker half (call INSIDE the worker). Returns the host proxy,
   * a typed emit, a typed on, and the reactive shared state. */
  worker(impl: NonNullable<C['worker']>): WorkerSide<C>;
  /** Implement the host half (call on the host with the Worker). Returns the
   * worker proxy augmented with on/emit/state/$ready. */
  host(worker: WorkerLike, impl?: NonNullable<C['host']>): HostSide<C>;
  /** Subscribe to a slice of the shared state by selector or explicit path. */
  watch<R>(
    state: NonNullable<C['state']>,
    selectorOrPath: ((s: NonNullable<C['state']>) => R) | StorePath,
    cb: (value: R) => void
  ): () => void;
}

function coerceKey(prop: string): string | number {
  const n = Number(prop);
  return Number.isInteger(n) && n >= 0 && String(n) === prop ? n : prop;
}

// Resolve a selector like `(s) => s.a.b[0]` to the path ['a','b',0] by running it
// against a path-recording proxy.
function resolvePath(sel: (s: any) => any): StorePath {
  const path: StorePath = [];
  const rec: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string') path.push(coerceKey(prop));
        return rec;
      },
    }
  );
  sel(rec);
  return path;
}

export function defineModule<C extends ModuleContract>(
  name: string
): Module<C> {
  const hostName = name + '$host';
  const stateKey = name + ':state';

  return {
    name,

    worker(impl) {
      const JSModuleG = globalThis.JSModule;
      const parentG = globalThis.parent;
      if (!JSModuleG || !parentG) {
        throw new Error('defineModule().worker() must run inside a worker');
      }
      const m = new JSModuleG(name, impl);
      const store = new SharedStore(stateKey);
      const hostProxy = parentG.module(hostName);
      return {
        host: hostProxy,
        emit: (event: any, payload: any) => m.emit(event, payload),
        on: (event: any, cb: any) => hostProxy.$on(event, cb),
        state: reactive(store, 'state'),
        dispose: () => m.dispose(),
      } as WorkerSide<C>;
    },

    host(worker, impl) {
      // Always register the host module (even empty) so the host can emit
      // hostEvents and the worker can call back into it.
      const handle = worker.registerModule(hostName, (impl || {}) as Fns);
      const remote = worker.module(name);
      const store = new SharedStore(stateKey);
      const extras: any = {
        on: (event: string, cb: any) => remote.$on(event, cb),
        emit: (event: string, payload: any) => handle.emit(event, payload),
        state: reactive(store, 'state'),
        $ready: (timeoutMs?: number) => worker.ready(name, timeoutMs),
      };
      // A proxy so `side.someWorkerMethod()` reaches the remote while on/emit/
      // state/$ready resolve to the extras.
      return new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop === 'string' && prop in extras) return extras[prop];
            if (typeof prop === 'symbol') return undefined;
            return remote[prop];
          },
        }
      ) as HostSide<C>;
    },

    watch(_state, selectorOrPath, cb) {
      const path = Array.isArray(selectorOrPath)
        ? selectorOrPath
        : resolvePath(selectorOrPath as (s: any) => any);
      const store = new SharedStore(stateKey);
      return store.subscribeIn('state', path, (_relPath, value) => cb(value));
    },
  };
}
