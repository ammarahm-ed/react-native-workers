import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  multiply(a: number, b: number): number;

  // Installs JSI globals used by the Worker class (idempotent).
  install(): boolean;
  // kind: 'inline' | 'url' | 'asset'. Returns the worker id. `nativeModules`
  // opts the worker into the platform (Java/ObjC) TurboModule manager.
  createWorker(
    kind: string,
    value: string,
    sourceUrl: string,
    name: string,
    nativeModules: boolean
  ): number;
  // Like createWorker, but the worker's JS runs on the UI/main thread (UIWorker).
  // UIWorker runtimes are shared and persistent by default: a second call with
  // the same `sourceUrl` reconnects to the already-loaded runtime (a new
  // connection id) instead of re-evaluating the script. Pass `independent` to
  // force a fresh private runtime with 1:1 lifetime (the background-Worker model).
  createUIWorker(
    kind: string,
    value: string,
    sourceUrl: string,
    name: string,
    nativeModules: boolean,
    independent: boolean,
    inspectable: boolean
  ): number;
  terminate(id: number): void;

  // Force-reap the persistent UIWorker runtime for `sourceUrl`: joins its thread
  // and clears it from the registry, so a later createUIWorker with that URL
  // builds a fresh one. Every connection (handle) on that runtime goes inert.
  // No-op for URLs with no shared runtime (e.g. independent workers).
  terminateUIWorkerRuntime(sourceUrl: string): void;

  // Verifies the native/UI-thread worker API (a worker created from C++, not JS).
  nativeWorkerSelfTest(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ReactNativeWorkers');
