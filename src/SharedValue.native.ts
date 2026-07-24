import NativeReactNativeWorkers from './NativeReactNativeWorkers';

declare const globalThis: any;

let installed = false;
function ensureInstalled(): void {
  if (installed) return;
  NativeReactNativeWorkers.install();
  installed = true;
}

/**
 * A single synchronous shared cell, shared by name across the host and all
 * workers — the fast primitive for hot values (positions, progress, gesture
 * state), analogous to a Reanimated shared value.
 *
 * Reads/writes are synchronous and local (no thread hop, no message). Numbers
 * take a lock-free atomic path; other structured-cloneable values go through the
 * codec under a light lock. Writes notify `subscribe` listeners only when there
 * are any — an animation loop that just reads/writes pays no notification cost.
 */
export class SharedValue<T = number> {
  private readonly _h: any;

  constructor(name: string, initial?: T) {
    ensureInstalled();
    this._h = globalThis.__rnworkersOpenSharedValue(name, initial);
  }

  get value(): T {
    return this._h.value;
  }
  set value(v: T) {
    this._h.value = v;
  }

  /** Observe changes (fires on any runtime's write). Returns an unsubscribe fn. */
  subscribe(cb: (value: T) => void): () => void {
    return this._h.subscribe(cb);
  }

  /**
   * Release a named cell process-wide, freeing its memory once the last live
   * handle is gone. Returns `true` if the name existed.
   *
   * Named cells otherwise live for the lifetime of the PROCESS — they are not
   * owned by any runtime, so they outlive every worker that touched them and
   * even a JS reload. That is what makes them shared, but it means dynamically
   * named cells (per session, per document) accumulate forever unless deleted.
   *
   * Instances created before the delete keep working, but are detached: they now
   * refer to an orphaned cell, and the next `new SharedValue(name, initial)`
   * creates a fresh one (re-seeding `initial`) that they do NOT observe. Delete
   * only when you are done with the name everywhere, including in workers.
   */
  static delete(name: string): boolean {
    ensureInstalled();
    return globalThis.__rnworkersDeleteSharedValue(name);
  }
}
