import { installWorkerGlobals } from './Worker';

export {
  Worker,
  UIWorker,
  nativeWorkerSelfTest,
  installWorkerGlobals,
} from './Worker';

// Install at IMPORT time, not at first Worker construction.
//
// The transferred-buffer guard works by replacing the global typed-array
// constructors, so any code holding a reference captured before the patch keeps
// an unguarded one. Importing this library is the earliest hook we have; failure
// is swallowed (the lazy path installs later) so a not-yet-ready native module
// can never break an import.
installWorkerGlobals();
export { SharedStore } from './SharedStore';
export type { StoreListener, Unsubscribe } from './SharedStore';
export { SharedValue } from './SharedValue';
export { SharedBuffer } from './SharedBuffer';
export { reactive } from './reactive';
export { defineModule } from './defineModule';
export type {
  ModuleContract,
  Module,
  WorkerSide,
  HostSide,
} from './defineModule';
export { WorkerTerminatedError } from './bridge';
export type {
  Remote,
  RemoteExtras,
  JSModuleImpl,
  ModuleHandle,
  BridgeEndpoint,
} from './bridge';
export type { WorkerThread, ThreadApi } from './threads';
export { __workerRef } from './resolveWorkerSource';
export type { WorkerOptions } from './Worker';
export type { WorkerSourceInput, WorkerRef } from './resolveWorkerSource';
