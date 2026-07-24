// Web fallback: a simple in-page store (no cross-thread sharing on web).
export type StoreListener = (key: string, value: any) => void;
export type Unsubscribe = () => void;
export type StorePath = Array<string | number>;
export type StorePathListener = (relPath: StorePath, value: any) => void;

const stores = new Map<string, SharedStore>();

function readPath(root: any, path: StorePath): any {
  let node = root;
  for (const seg of path) {
    if (node == null) return undefined;
    node = node[seg];
  }
  return node;
}

function writePath(root: any, path: StorePath, value: any): any {
  if (path.length === 0) return value;
  const isIndex = typeof path[0] === 'number';
  const next = root == null ? (isIndex ? [] : {}) : root;
  next[path[0]!] = writePath(next[path[0]!], path.slice(1), value);
  return next;
}

export class SharedStore {
  private _map = new Map<string, any>();
  private _subs: Array<{
    key: string;
    path: StorePath | null;
    cb: StoreListener | StorePathListener;
  }> = [];
  private _batchDepth = 0;
  private _batched = new Map<string, StorePath>();

  constructor(name: string = 'default') {
    const existing = stores.get(name);
    if (existing) return existing;
    stores.set(name, this);
  }

  batch(fn: () => void): void {
    this.batchBegin();
    try {
      fn();
    } finally {
      this.batchEnd();
    }
  }
  batchBegin(): void {
    this._batchDepth++;
  }
  batchEnd(): void {
    this._batchDepth--;
    if (this._batchDepth === 0) {
      const pending = this._batched;
      this._batched = new Map();
      for (const key of pending.keys()) this._notify(key, []);
    }
  }

  private _notify(key: string, changedPath: StorePath): void {
    if (this._batchDepth > 0) {
      this._batched.set(key, changedPath);
      return;
    }
    for (const s of this._subs.slice()) {
      if (s.key !== '' && s.key !== key) continue;
      if (s.path == null) {
        (s.cb as StoreListener)(key, this._map.get(key));
      } else {
        const w = s.path;
        const isPrefix = (p: StorePath, c: StorePath) =>
          p.length <= c.length && p.every((seg, i) => seg === c[i]);
        if (isPrefix(w, changedPath)) {
          const rel = changedPath.slice(w.length);
          (s.cb as StorePathListener)(
            rel,
            readPath(this._map.get(key), changedPath)
          );
        } else if (isPrefix(changedPath, w)) {
          (s.cb as StorePathListener)([], readPath(this._map.get(key), w));
        }
      }
    }
  }

  get(key: string): any {
    return this._map.get(key);
  }
  set(key: string, value: any): void {
    this._map.set(key, value);
    this._notify(key, []);
  }
  getIn(key: string, path: StorePath): any {
    return readPath(this._map.get(key), path);
  }
  setIn(key: string, path: StorePath, value: any): void {
    if (path.length === 0) return this.set(key, value);
    this._map.set(key, writePath(this._map.get(key), path, value));
    this._notify(key, path);
  }
  merge(key: string, partial: Record<string, any>): void {
    const deepMerge = (base: any, patch: any): any => {
      if (
        patch == null ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        base == null ||
        typeof base !== 'object' ||
        Array.isArray(base)
      ) {
        return patch;
      }
      const out: any = { ...base };
      for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
      return out;
    };
    this._map.set(key, deepMerge(this._map.get(key), partial));
    this._notify(key, []);
  }
  deleteIn(key: string, path: StorePath): boolean {
    if (path.length === 0) return this.delete(key);
    const parent = readPath(this._map.get(key), path.slice(0, -1));
    const last = path[path.length - 1]!;
    if (parent == null || typeof parent !== 'object') return false;
    if (Array.isArray(parent)) {
      if (typeof last !== 'number' || last >= parent.length) return false;
      parent.splice(last, 1);
    } else {
      if (!(last in parent)) return false;
      delete parent[last];
    }
    this._notify(key, path);
    return true;
  }
  has(key: string): boolean {
    return this._map.has(key);
  }
  delete(key: string): boolean {
    const had = this._map.delete(key);
    if (had) this._notify(key, []);
    return had;
  }
  keys(): string[] {
    return Array.from(this._map.keys());
  }
  subscribe(key: string, cb: StoreListener): Unsubscribe {
    return this._add({ key, path: null, cb });
  }
  subscribeIn(
    key: string,
    path: StorePath,
    cb: StorePathListener
  ): Unsubscribe {
    return this._add({ key, path, cb });
  }
  watch(cb: StoreListener): Unsubscribe {
    return this._add({ key: '', path: null, cb });
  }

  private _add(entry: {
    key: string;
    path: StorePath | null;
    cb: StoreListener | StorePathListener;
  }): Unsubscribe {
    this._subs.push(entry);
    return () => {
      const i = this._subs.indexOf(entry);
      if (i !== -1) this._subs.splice(i, 1);
    };
  }

  static delete(name: string): boolean {
    return stores.delete(name);
  }
}
