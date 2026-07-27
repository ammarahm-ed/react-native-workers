import NativeReactNativeWorkers from './NativeReactNativeWorkers';
import {
  resolveWorkerSource,
  type WorkerSourceInput,
} from './resolveWorkerSource';
import {
  BRIDGE,
  createBridge,
  type BridgeEndpoint,
  type JSModuleImpl,
  type ModuleHandle,
  type Remote,
} from './bridge';

type Listener = (event: any) => void;

/** Short identity for logs: the source URL's file stem, minus query/extension. */
function workerStem(sourceUrl: string): string {
  if (!sourceUrl) return '';
  let s = sourceUrl.split('?')[0] ?? '';
  s = s.substring(s.lastIndexOf('/') + 1);
  const dot = s.indexOf('.');
  return dot > 0 ? s.substring(0, dot) : s;
}

const registry = new Map<number, (type: string, payload: any) => void>();
let installed = false;

declare const globalThis: any;
declare const fetch: any;

/**
 * Mirrors the native validation (cpp/core/MessageCodec.cpp) for the queued case.
 * Only the checks that need no runtime: type, duplicates, already-transferred.
 */
function assertTransferable(transfer: any[]): void {
  if (!Array.isArray(transfer) || transfer.length === 0) return;
  const seen: any[] = [];
  for (const item of transfer) {
    const isArrayBuffer =
      item != null &&
      typeof item === 'object' &&
      Object.prototype.toString.call(item) === '[object ArrayBuffer]';
    if (!isArrayBuffer) {
      throw new Error(
        "Failed to execute 'postMessage': the transfer list contains a value " +
          'that is not a transferable object.'
      );
    }
    if ((item as any).detached === true) {
      throw new Error(
        "Failed to execute 'postMessage': an ArrayBuffer in the transfer list " +
          'has already been transferred.'
      );
    }
    if (seen.indexOf(item) !== -1) {
      throw new Error(
        "Failed to execute 'postMessage': an ArrayBuffer appears twice in the " +
          'transfer list.'
      );
    }
    seen.push(item);
  }
}

function ensureInstalled(): void {
  if (installed) return;
  NativeReactNativeWorkers.install();
  // The message codec rebuilds an incoming SharedBuffer through the global
  // constructor. Setting it here — on the path every Worker takes — rather than
  // relying on SharedBuffer.native.ts having been imported means a host that
  // never touched SharedBuffer still receives a real one instead of a bare
  // ArrayBuffer.
  if (globalThis.SharedBuffer == null) {
    globalThis.SharedBuffer = require('./SharedBuffer').SharedBuffer;
  }
  // Native delivers worker -> host events by invoking this global on the host
  // JS thread (via the host CallInvoker). Payload is already deserialized.
  globalThis.__rnworkersDeliver = (id: number, type: string, payload: any) => {
    const deliver = registry.get(id);
    if (deliver) deliver(type, payload);
  };
  installed = true;
}

export interface WorkerOptions {
  name?: string;
  /** Per-worker Hermes heap cap in MB (default 256). */
  maxHeapMb?: number;
  /**
   * Opt the worker into the platform (Java/ObjC) native-module bridge so it can
   * access ALL registered TurboModules. Off by default because building the
   * per-worker manager costs memory and teardown; C++ modules and nested workers
   * work without it.
   */
  nativeModules?: boolean;
  /**
   * UIWorker only. By default UIWorker runtimes are SHARED and PERSISTENT: two
   * `new UIWorker('same/path')` attach to one runtime that is evaluated once and
   * lives for the app's lifetime (so anything it registers survives navigation),
   * and `terminate()` only disconnects the handle. Set `independent: true` to get
   * a fresh private runtime with 1:1 lifetime — `terminate()` reaps it, exactly
   * like a background `Worker`. Ignored by the background `Worker`.
   */
  independent?: boolean;
  /**
   * UIWorker only, dev only. Register this UIWorker as its own DevTools target so
   * you can set breakpoints and step through it. OFF by default and generally NOT
   * recommended: a UIWorker runs on the platform main thread, so a debugger pause
   * FREEZES the whole app UI (and the OS may kill it as unresponsive). Console is
   * always forwarded to the host regardless; prefer that. Background `Worker`s are
   * always inspectable and ignore this. No effect in release.
   */
  inspectable?: boolean;
}

/** Verifies the native/UI-thread worker API (a worker created from C++). */
/**
 * Installs the native globals (including the transferred-buffer access guard)
 * without creating a Worker.
 *
 * Called at import time from src/index.tsx. The guard replaces the global view
 * constructors, so anything that captured `Uint8Array` into a local BEFORE the
 * patch keeps an unguarded reference — installing at import shrinks that window
 * to whatever runs before this module is first imported, instead of leaving it
 * open until the first Worker is constructed.
 *
 * Safe to call repeatedly and safe to fail: if the TurboModule is not ready this
 * early in bridgeless startup, it stays uninstalled and the normal lazy path
 * installs it later.
 */
export function installWorkerGlobals(): boolean {
  try {
    ensureInstalled();
    return true;
  } catch {
    return false;
  }
}

export function nativeWorkerSelfTest(): Promise<string> {
  return NativeReactNativeWorkers.nativeWorkerSelfTest();
}

export class Worker {
  private _id: number | null = null;
  private readonly _listeners: Record<string, Listener[]> = Object.create(null);
  private _terminated = false;
  /** Kept for log tagging, so worker output is attributable on the host. */
  private _name = '';
  private _pending: Array<{ data: any; transfer: any[] }> = [];

  // Incoming 'message' events are buffered until a message handler is attached
  // (onmessage set or addEventListener('message')), matching the Web spec's
  // port message queue.
  private _messageStarted = false;
  private _messageBuffer: any[] = [];
  private _onmessage: Listener | null = null;

  protected _nativeModules = false;
  protected _independent = false;
  protected _inspectable = false;
  /** Resolved worker source URL — the key for shared UIWorker runtimes. */
  protected _sourceUrl = '';
  private _bridge: BridgeEndpoint | null = null;

  onerror: Listener | null = null;
  onmessageerror: Listener | null = null;

  get onmessage(): Listener | null {
    return this._onmessage;
  }
  set onmessage(cb: Listener | null) {
    this._onmessage = cb;
    if (cb) this._startMessages();
  }

  private _startMessages(): void {
    if (this._messageStarted) return;
    this._messageStarted = true;
    const buffered = this._messageBuffer;
    this._messageBuffer = [];
    for (const ev of buffered) this.__fire('message', ev);
  }

  constructor(source: WorkerSourceInput, options: WorkerOptions = {}) {
    ensureInstalled();
    const desc = resolveWorkerSource(source);
    const name = options.name ?? '';
    // Fall back to the bundle's file stem so log tags read `[Worker:search]`
    // rather than `[Worker:3]`. Mirrors the debugger target naming.
    this._name = name || workerStem(desc.sourceUrl);
    this._nativeModules = options.nativeModules ?? false;
    this._independent = options.independent ?? false;
    this._inspectable = options.inspectable ?? false;
    this._sourceUrl = desc.sourceUrl;

    if (desc.kind === 'url') {
      // Dev: fetch the worker bundle from Metro in JS, then run it inline.
      fetch(desc.value)
        .then((r: any) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then((code: string) =>
          this._create('inline', code, desc.sourceUrl, name)
        )
        .catch((err: any) =>
          this.__deliver('error', {
            message: 'Failed to load worker bundle: ' + String(err),
            filename: desc.value,
            stack: err?.stack ?? '',
            error: err,
          })
        );
    } else {
      // 'inline' or 'asset' (native loads the asset).
      this._create(desc.kind, desc.value, desc.sourceUrl, name);
    }
  }

  // Overridden by UIWorker to create a runtime on the UI/main thread.
  protected _nativeCreate(
    kind: string,
    value: string,
    sourceUrl: string,
    name: string,
    nativeModules: boolean
  ): number {
    return NativeReactNativeWorkers.createWorker(
      kind,
      value,
      sourceUrl,
      name,
      nativeModules
    );
  }

  private _create(
    kind: string,
    value: string,
    sourceUrl: string,
    name: string
  ): void {
    if (this._terminated) return;
    this._id = this._nativeCreate(
      kind,
      value,
      sourceUrl,
      name,
      this._nativeModules
    );
    registry.set(this._id, (type, payload) => this.__deliver(type, payload));
    // Flush anything queued before the worker existed.
    //
    // Each send is guarded and the queue is ALWAYS cleared. A throwing encode
    // (a DataCloneError from a transfer list) used to escape this loop into the
    // caller's `.catch`, where it was reported as "Failed to load worker bundle"
    // and left the rest of the queue undelivered while the worker looked healthy.
    const pending = this._pending;
    this._pending = [];
    for (const m of pending) {
      try {
        globalThis.__RNWorkersPostMessage(this._id, m.data, m.transfer);
      } catch (err) {
        this.__deliver('messageerror', {
          message: String((err as any)?.message ?? err),
        });
      }
    }
  }

  // ---- JSModule bridge (typed two-way RPC) ----
  private _ensureBridge(): BridgeEndpoint {
    if (!this._bridge) {
      this._bridge = createBridge((m) => this.postMessage(m));
    }
    return this._bridge;
  }

  /** Typed proxy to call a module the worker registered via `new JSModule(...)`.
   * Every method returns a Promise; `.$on(event, cb)` and `.$ready()` are also
   * available. Calls before the worker registers the module are queued. */
  module<T>(name: string): Remote<T> {
    return this._ensureBridge().remote<T>(name);
  }

  /** Register a module on the host that the worker can call via `parent.module(name)`. */
  registerModule(name: string, impl: JSModuleImpl): ModuleHandle {
    return this._ensureBridge().registerModule(name, impl);
  }

  /** Resolves once the worker has registered the named module. */
  ready(name: string, timeoutMs?: number): Promise<void> {
    return this._ensureBridge().ready(name, timeoutMs);
  }

  postMessage(data: any, transfer: any[] = []): void {
    if (this._terminated) return;
    if (this._id == null) {
      // A file worker in dev only gets its id after its bundle is fetched, so
      // early messages queue. Validate the transfer list NOW anyway: the spec
      // says postMessage throws DataCloneError synchronously, and deferring it
      // to the flush made the same call throw or not depending on whether the
      // worker happened to exist yet.
      assertTransferable(transfer);
      this._pending.push({ data, transfer });
      return;
    }
    globalThis.__RNWorkersPostMessage(this._id, data, transfer);
  }

  terminate(): void {
    if (this._terminated) return;
    this._terminated = true;
    this._pending = [];
    if (this._bridge) {
      this._bridge.dispose();
      this._bridge = null;
    }
    if (this._id != null) {
      registry.delete(this._id);
      NativeReactNativeWorkers.terminate(this._id);
    }
  }

  addEventListener(type: string, cb: Listener): void {
    if (typeof cb !== 'function') return;
    (this._listeners[type] || (this._listeners[type] = [])).push(cb);
    if (type === 'message') this._startMessages();
  }

  removeEventListener(type: string, cb: Listener): void {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(cb);
    if (i !== -1) arr.splice(i, 1);
  }

  dispatchEvent(event: any): boolean {
    this.__fire(event.type, event);
    return true;
  }

  private __fire(type: string, event: any): void {
    const on = (this as any)['on' + type];
    if (typeof on === 'function') on.call(this, event);
    const arr = this._listeners[type];
    if (arr) {
      for (const cb of arr.slice()) cb.call(this, event);
    }
  }

  private __deliver(type: string, payload: any): void {
    if (type === 'message') {
      // Bridge traffic is multiplexed over the message channel; intercept it
      // before it reaches the user's onmessage.
      if (payload && payload[BRIDGE] === 1) {
        this._ensureBridge().handleIncoming(payload);
        return;
      }
      const ev = {
        type: 'message',
        data: payload,
        origin: '',
        lastEventId: '',
      };
      if (!this._messageStarted) {
        this._messageBuffer.push(ev);
      } else {
        this.__fire('message', ev);
      }
    } else if (type === 'log') {
      // Worker console output, surfaced on the host so it lands wherever app
      // logs already go (Metro, DevTools). Tagged with the worker's identity
      // because otherwise it is indistinguishable from host output — and with
      // several workers running, from each other. The worker's OWN DevTools
      // console still receives the original call; this is an additional copy.
      const tag = `[Worker:${this._name || this._id}]`;
      const level: string = payload?.level ?? 'log';
      const fn =
        level === 'error'
          ? console.error
          : level === 'warn'
            ? console.warn
            : level === 'debug'
              ? (console.debug ?? console.log)
              : console.log;
      fn.call(console, tag, payload?.text ?? '');
    } else if (type === 'error') {
      // Native always sends the worker-side stack; surface it both as `stack`
      // and on a real Error in `error`. An uncaught error crosses runtimes as a
      // plain payload — the original Error object cannot come with it — so
      // without rebuilding one here `e.error?.stack` is always undefined and a
      // worker failure is reported with no indication of where it came from.
      const stack: string = payload?.stack ?? '';
      let error = payload?.error;
      if (error == null) {
        error = new Error(payload?.message ?? 'Unknown worker error');
        if (stack) {
          error.stack = stack;
        }
      }
      this.__fire('error', {
        type: 'error',
        message: payload?.message ?? '',
        filename: payload?.filename ?? '',
        lineno: payload?.lineno ?? 0,
        colno: payload?.colno ?? 0,
        stack,
        error,
      });
    } else if (type === 'messageerror') {
      this.__fire('messageerror', { type: 'messageerror' });
    }
  }
}

/**
 * Non-spec worker whose JS runtime runs on the platform UI/main thread, so its
 * code can call UI-affine native methods directly. Same API as Worker; note
 * that heavy work here competes with UI rendering. Supported on both platforms
 * (Android schedules onto the main Looper).
 */
export class UIWorker extends Worker {
  protected override _nativeCreate(
    kind: string,
    value: string,
    sourceUrl: string,
    name: string,
    nativeModules: boolean
  ): number {
    return NativeReactNativeWorkers.createUIWorker(
      kind,
      value,
      sourceUrl,
      name,
      nativeModules,
      this._independent,
      this._inspectable
    );
  }

  /**
   * Tear down the backing runtime, not just this handle.
   *
   * For a shared (default) UIWorker this reaps the persistent runtime for this
   * script's URL — joining its thread and invalidating EVERY handle attached to
   * it — and clears it from the registry, so a later `new UIWorker(samePath)`
   * builds a fresh one. Everything the runtime registered (native components,
   * singletons) is gone. For an `independent` worker it is just `terminate()`.
   *
   * `terminate()` only ever disconnects a shared handle; this is the explicit
   * way to actually stop the runtime.
   */
  terminateRuntime(): void {
    if (this._independent) {
      this.terminate();
      return;
    }
    // Detach this handle locally first (bridge + delivery), then reap the runtime.
    this.terminate();
    if (this._sourceUrl) {
      NativeReactNativeWorkers.terminateUIWorkerRuntime(this._sourceUrl);
    }
  }

  /**
   * Tear down the shared UIWorker runtime for a given source, without holding a
   * handle. No-op if no shared runtime exists for it (e.g. it was independent or
   * never created).
   */
  static terminateRuntime(source: WorkerSourceInput): void {
    ensureInstalled();
    const desc = resolveWorkerSource(source);
    if (desc.sourceUrl) {
      NativeReactNativeWorkers.terminateUIWorkerRuntime(desc.sourceUrl);
    }
  }
}
