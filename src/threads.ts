/**
 * EXPERIMENTAL: types for the worker-side `Thread` API.
 *
 * These describe globals that only exist INSIDE a worker runtime, so they are
 * types only — there is nothing to import at runtime. Declare what you use at
 * the top of a worker file, the same way worker code declares `self`:
 *
 * ```ts
 * import type { ThreadApi } from '@ammarahmed/react-native-workers';
 *
 * declare const Thread: ThreadApi;
 * declare function enableMultiThreadingExperimental(): boolean;
 * ```
 */

/** A thread this worker's JS can be run on. */
export interface WorkerThread {
  /** Display name. `'main'` for the platform main/UI thread. */
  readonly name: string;
  /** True once {@link dispose} has been called. */
  readonly disposed: boolean;
  /**
   * Runs `fn` on this thread and resolves with its return value.
   *
   * `fn` is a plain closure — it keeps every binding it captured, because there
   * is no second runtime and nothing is serialized. What changes is which OS
   * thread executes the runtime while `fn` runs.
   *
   * The promise always settles back on the worker's OWN thread, so code after an
   * `await` continues where it started. Thread changes only ever happen inside a
   * `run()` callback.
   *
   * Calls on one thread are serial: one at a time, in the order they were made.
   */
  run<T>(fn: () => T): Promise<T>;
  /**
   * Stops the thread. In-flight calls still settle; queued ones are dropped.
   * Returns false if it was already disposed. Throws for `Thread.main`.
   */
  dispose(): boolean;
}

/** The worker-global `Thread` object. */
export interface ThreadApi {
  /**
   * The platform main/UI thread. Throws where UIWorker is also unavailable
   * (no main-thread scheduler registered for the platform).
   */
  readonly main: WorkerThread;
  /**
   * Name of the thread currently executing, or `''` when running on the
   * worker's own thread.
   */
  readonly current: string;
  /** Creates a fresh serial background thread. */
  create(name?: string): WorkerThread;
}
