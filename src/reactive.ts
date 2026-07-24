// A reactive object backed by a SharedStore key. Property reads map to `getIn`
// (lazy), writes to `setIn`, deletes to `deleteIn`; nested objects/arrays return
// nested reactive proxies that remember their path. Writes in the same microtask
// coalesce into one batched SharedStore update + a single watcher notification.
//
// It LOOKS like a plain object but is shared, concurrent, cross-thread memory:
// writes propagate to watchers asynchronously and are last-writer-wins; a
// read-modify-write like `state.n++` is not atomic across runtimes. See docs.
import type { SharedStore, StorePath } from './SharedStore';

interface StoreLike {
  getIn(key: string, path: StorePath): any;
  setIn(key: string, path: StorePath, value: any): void;
  deleteIn(key: string, path: StorePath): boolean;
  batch(fn: () => void): void;
  batchBegin(): void;
  batchEnd(): void;
}

const ARRAY_MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

function coerceKey(prop: string): string | number {
  const n = Number(prop);
  return Number.isInteger(n) && n >= 0 && String(n) === prop ? n : prop;
}

// Coalesce a whole microtask's writes into one SharedStore batch: open the batch
// on the first write, close it on the next microtask. Writes apply immediately
// (reads stay consistent); only the notification is deferred + coalesced.
function makeScheduler(store: StoreLike): () => void {
  let open = false;
  return () => {
    if (open) return;
    open = true;
    store.batchBegin();
    Promise.resolve().then(() => {
      open = false;
      store.batchEnd();
    });
  };
}

function makeNode(
  store: StoreLike,
  rootKey: string,
  path: StorePath,
  schedule: () => void
): any {
  const child = (key: string | number): any => {
    const v = store.getIn(rootKey, [...path, key]);
    if (v !== null && typeof v === 'object') {
      return makeNode(store, rootKey, [...path, key], schedule);
    }
    return v;
  };

  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop === Symbol.iterator) {
        const arr = store.getIn(rootKey, path);
        if (!Array.isArray(arr)) return undefined;
        let i = 0;
        return function () {
          return {
            next: () =>
              i < arr.length
                ? { value: child(i++), done: false }
                : { value: undefined, done: true },
          };
        };
      }
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toJSON' || prop === 'valueOf') {
        return () => store.getIn(rootKey, path);
      }
      const key = coerceKey(prop);
      // Array-context props (length, methods) need the container.
      if (
        prop === 'length' ||
        typeof key === 'number' ||
        prop in Array.prototype
      ) {
        const cur = store.getIn(rootKey, path);
        if (Array.isArray(cur)) {
          if (prop === 'length') return cur.length;
          if (ARRAY_MUTATORS.has(prop)) {
            return (...args: any[]) => {
              schedule();
              // Read-modify-write the whole array through the store (correct for
              // every mutator; push/pop stay cheap-ish since arrays are small).
              const copy = cur.slice();
              const result = (copy as any)[prop](...args);
              store.setIn(rootKey, path, copy);
              return result;
            };
          }
          if (
            typeof (Array.prototype as any)[prop] === 'function' &&
            typeof key !== 'number'
          ) {
            // Read-only array method (map/filter/forEach/slice/indexOf/…).
            return (...args: any[]) => (cur as any)[prop](...args);
          }
        }
      }
      return child(key);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return true;
      schedule();
      store.setIn(rootKey, [...path, coerceKey(prop)], value);
      return true;
    },
    deleteProperty(_t, prop) {
      if (typeof prop === 'symbol') return true;
      schedule();
      store.deleteIn(rootKey, [...path, coerceKey(prop)]);
      return true;
    },
    has(_t, prop) {
      if (typeof prop === 'symbol') return false;
      return store.getIn(rootKey, [...path, coerceKey(prop)]) !== undefined;
    },
    ownKeys(_t) {
      const v = store.getIn(rootKey, path);
      return v != null && typeof v === 'object' ? Reflect.ownKeys(v) : [];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      const v = store.getIn(rootKey, [...path, coerceKey(prop)]);
      if (v === undefined) return undefined;
      return {
        enumerable: true,
        configurable: true,
        writable: true,
        value: child(coerceKey(prop)),
      };
    },
  });
}

/**
 * Wrap a SharedStore key as a reactive object. Reads/writes look like a normal
 * object but go through the store's lazy `getIn` / granular `setIn`.
 */
export function reactive<T extends object = any>(
  store: SharedStore | StoreLike,
  rootKey = 'state'
): T {
  const s = store as StoreLike;
  return makeNode(s, rootKey, [], makeScheduler(s)) as T;
}
