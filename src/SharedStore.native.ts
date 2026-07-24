import NativeReactNativeWorkers from './NativeReactNativeWorkers';

declare const globalThis: any;

let installed = false;
function ensureInstalled(): void {
  if (installed) return;
  NativeReactNativeWorkers.install();
  installed = true;
}

export type StoreListener = (key: string, value: any) => void;
export type Unsubscribe = () => void;
/** A path into a stored value: object keys (string) and array indices (number). */
export type StorePath = Array<string | number>;
/** Granular watcher: `relPath` is the changed path relative to the watched path. */
export type StorePathListener = (relPath: StorePath, value: any) => void;

/**
 * Non-spec shared state shared across the host and all workers. A named store is
 * a single C++-owned, mutex-guarded map: reads/writes are synchronized and
 * subscribers are notified on change. Values may be any structured-cloneable
 * data.
 */
export class SharedStore {
  private readonly _h: any;

  constructor(name: string = 'default') {
    ensureInstalled();
    this._h = globalThis.__rnworkersOpenStore(name);
  }

  /**
   * Read a value. Objects/arrays come back as a lazy snapshot proxy: nested
   * fields are decoded only when accessed, and reflect the store as of this call.
   */
  get(key: string): any {
    return this._h.get(key);
  }
  set(key: string, value: any): void {
    this._h.set(key, value);
  }
  /** Read a nested value directly, decoding only that subtree. */
  getIn(key: string, path: StorePath): any {
    return this._h.getIn(key, path);
  }
  /**
   * Update a nested value in place. Only `value` is encoded and only the
   * root→path spine is rebuilt (structural sharing) — the rest of the stored
   * value is untouched. Watchers receive just the changed slice.
   */
  setIn(key: string, path: StorePath, value: any): void {
    this._h.setIn(key, path, value);
  }
  /** Deep-merge a partial object into the stored value (objects merge; arrays/
   * primitives replace). Only the changed nodes are rebuilt. */
  merge(key: string, partial: Record<string, any>): void {
    this._h.merge(key, partial);
  }
  /** Remove a nested value. Array entries splice (indices shift). Returns whether
   * anything was removed. */
  deleteIn(key: string, path: StorePath): boolean {
    return this._h.deleteIn(key, path);
  }
  has(key: string): boolean {
    return this._h.has(key);
  }
  delete(key: string): boolean {
    return this._h.delete(key);
  }
  keys(): string[] {
    return this._h.keys();
  }
  /**
   * Run `fn` with change notifications deferred: every write inside applies
   * immediately (reads stay consistent), but watchers are notified **once** per
   * changed key after `fn` returns. Coalesces a burst of `setIn`s into a single
   * atomic update + one notification.
   */
  batch(fn: () => void): void {
    this._h.batch(fn);
  }
  /** Open a manual batch bracket (advanced; pair with `batchEnd`). Used by the
   * reactive-state layer to coalesce a whole tick's writes. */
  batchBegin(): void {
    this._h.batchBegin();
  }
  /** Close a manual batch bracket, flushing coalesced notifications at depth 0. */
  batchEnd(): void {
    this._h.batchEnd();
  }
  /** Watch a single key. Returns an unsubscribe function. */
  subscribe(key: string, cb: StoreListener): Unsubscribe {
    return this._h.subscribe(key, cb);
  }
  /**
   * Watch a nested path. The callback fires only when a change touches that
   * subtree, and receives `(relPath, value)` — the changed slice, not the whole
   * value. Returns an unsubscribe function.
   */
  subscribeIn(
    key: string,
    path: StorePath,
    cb: StorePathListener
  ): Unsubscribe {
    return this._h.subscribeIn(key, path, cb);
  }
  /** Watch all keys. Returns an unsubscribe function. */
  watch(cb: StoreListener): Unsubscribe {
    return this._h.watch(cb);
  }

  /**
   * Release a named store process-wide, dropping all of its keys. Returns `true`
   * if the name existed. See `SharedValue.delete` — same lifetime rules.
   *
   * Handles opened earlier keep working but are detached: they read and write an
   * orphaned store that nothing else can reach, and re-opening the name yields a
   * fresh empty one. Note this does NOT unsubscribe existing listeners — they
   * simply stop hearing from anyone. Prefer clearing keys if the store is still
   * in use; delete when the name itself is finished with.
   */
  static delete(name: string): boolean {
    ensureInstalled();
    return globalThis.__rnworkersDeleteStore(name);
  }
}
