import NativeReactNativeWorkers from './NativeReactNativeWorkers';

declare const globalThis: any;

let installed = false;
function ensureInstalled(): void {
  if (installed) return;
  NativeReactNativeWorkers.install();
  installed = true;
}

/**
 * A named block of raw shared memory. Every runtime that opens the same name gets
 * an `ArrayBuffer` over the SAME native bytes, so typed-array views read/write the
 * same memory with zero per-element cost — the high-throughput primitive for bulk
 * per-frame math or large mutable data.
 *
 * It is raw memory with NO implicit synchronization: concurrent overlapping writes
 * from two runtimes race. Use `withLock` for a cross-runtime critical section, or
 * a single-writer / double-buffer discipline.
 */
export class SharedBuffer {
  /** An ArrayBuffer over the shared memory (put a typed-array view over it). */
  readonly arrayBuffer: ArrayBuffer;
  readonly byteLength: number;
  private readonly _lock: any;

  /** The name this buffer was opened under. */
  readonly name: string;

  constructor(name: string, byteLength: number) {
    ensureInstalled();
    this.arrayBuffer = globalThis.__rnworkersOpenSharedBuffer(name, byteLength);
    this.byteLength = this.arrayBuffer.byteLength;
    this._lock = globalThis.__rnworkersOpenSharedLock(name);
    this.name = name;
    // What the message codec matches on to pass this buffer BY REFERENCE
    // (cpp/core/MessageCodec.cpp, TAG_SHAREDBUFFER) instead of copying its
    // bytes. Non-enumerable so it never shows up in user iteration or JSON.
    Object.defineProperty(this, '__rnworkersSharedBufferName', {
      value: name,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /** Run `fn` holding this buffer's cross-runtime lock; returns fn's result. */
  withLock<T>(fn: () => T): T {
    let r: T;
    this._lock.withLock(() => {
      r = fn();
    });
    return r!;
  }

  /**
   * Release a named buffer process-wide. Returns `true` if the name existed.
   * See `SharedValue.delete` — same lifetime rules and the same reason to care.
   *
   * `ArrayBuffer`s handed out earlier stay valid (they keep the bytes alive), but
   * are detached from the name: re-opening it allocates FRESH memory that no
   * longer aliases them, and its `byteLength` is fixed by that new first opener.
   * This matters most for buffers, which are the largest allocations here.
   */
  static delete(name: string): boolean {
    ensureInstalled();
    return globalThis.__rnworkersDeleteSharedBuffer(name);
  }
}

// The message codec rebuilds an incoming SharedBuffer through this constructor,
// so a buffer posted from a worker arrives on the host as a real SharedBuffer —
// same API, same memory. Workers get theirs from the prelude.
globalThis.SharedBuffer = globalThis.SharedBuffer ?? SharedBuffer;
