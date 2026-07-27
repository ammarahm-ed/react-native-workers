// Web fallback: defer to the browser's native Worker when available.
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

export interface WorkerOptions {
  name?: string;
  maxHeapMb?: number;
  /** Native-only; ignored on web. Kept for cross-platform type parity. */
  nativeModules?: boolean;
  /** Native UIWorker-only; ignored on web. Kept for cross-platform type parity. */
  independent?: boolean;
  /** Native UIWorker-only; ignored on web. Kept for cross-platform type parity. */
  inspectable?: boolean;
}

export function nativeWorkerSelfTest(): Promise<string> {
  return Promise.reject(new Error('nativeWorkerSelfTest is native-only'));
}

const NativeWorker: any =
  typeof globalThis !== 'undefined' ? (globalThis as any).Worker : undefined;

export class Worker {
  private impl: any;
  private _bridge: BridgeEndpoint | null = null;
  private _userOnmessage: any = null;

  constructor(source: WorkerSourceInput, options: WorkerOptions = {}) {
    if (!NativeWorker) {
      throw new Error('Worker is not supported in this environment');
    }
    const desc = resolveWorkerSource(source);
    const url =
      desc.kind === 'inline'
        ? URL.createObjectURL(
            new Blob([desc.value], { type: 'text/javascript' } as any)
          )
        : desc.value;
    this.impl = new NativeWorker(url, { name: options.name });
    // Route incoming messages so bridge traffic is intercepted before the user.
    this.impl.onmessage = (e: any) => {
      if (e && e.data && e.data[BRIDGE] === 1) {
        this._ensureBridge().handleIncoming(e.data);
        return;
      }
      if (this._userOnmessage) this._userOnmessage(e);
    };
  }

  private _ensureBridge(): BridgeEndpoint {
    if (!this._bridge) {
      this._bridge = createBridge((m) => this.impl.postMessage(m));
    }
    return this._bridge;
  }

  module<T>(name: string): Remote<T> {
    return this._ensureBridge().remote<T>(name);
  }
  registerModule(name: string, impl: JSModuleImpl): ModuleHandle {
    return this._ensureBridge().registerModule(name, impl);
  }
  ready(name: string, timeoutMs?: number): Promise<void> {
    return this._ensureBridge().ready(name, timeoutMs);
  }

  postMessage(data: any, transfer: any[] = []) {
    this.impl.postMessage(data, transfer);
  }
  terminate() {
    if (this._bridge) {
      this._bridge.dispose();
      this._bridge = null;
    }
    this.impl.terminate();
  }
  addEventListener(type: string, cb: any) {
    this.impl.addEventListener(type, cb);
  }
  removeEventListener(type: string, cb: any) {
    this.impl.removeEventListener(type, cb);
  }
  dispatchEvent(event: any) {
    return this.impl.dispatchEvent(event);
  }
  set onmessage(cb: any) {
    this._userOnmessage = cb;
  }
  set onerror(cb: any) {
    this.impl.onerror = cb;
  }
  set onmessageerror(cb: any) {
    this.impl.onmessageerror = cb;
  }
}

// On web there is no separate UI thread; UIWorker behaves like Worker.
export class UIWorker extends Worker {
  /** Native-only; a no-op on web. Tears down the backing UIWorker runtime. */
  terminateRuntime(): void {
    this.terminate();
  }

  /** Native-only; a no-op on web. */
  static terminateRuntime(_source: WorkerSourceInput): void {}
}

/** Web fallback: nothing native to install. */
export function installWorkerGlobals(): boolean {
  return false;
}

/**
 * Web fallback: the browser detaches transferred buffers itself, so there is
 * nothing to emulate and nothing to patch.
 */
export function enableTransferGuard(): boolean {
  return false;
}
