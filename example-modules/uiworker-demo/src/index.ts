/**
 * Example-only module. Not part of react-native-workers' API — it exists to show
 * what a UIWorker makes possible, and lives outside the library on purpose.
 *
 * `UIWorkerDemo` is a C++ (Cxx) TurboModule rather than an ObjC/Java one, and
 * that choice is the whole point. RN's ObjC bridge posts every void method onto
 * the module's method queue ("void methods are always async" —
 * RCTTurboModule.mm), so an ObjC module is never a direct call regardless of the
 * caller's thread. A Cxx TurboModule has no method queue and runs synchronously
 * on the calling runtime's thread — which, inside a UIWorker, is the main thread.
 * So these calls reach UIKit with no dispatch and no serialization.
 */

export interface UIWorkerDemoModule {
  /** True when the calling runtime is on the platform main/UI thread. */
  isOnMainThread(): boolean;
  /** Human-readable identity of the calling thread — proof of where you are. */
  threadName(): string;
  /** Presents a native alert directly. Main thread only. */
  showAlert(title: string, message: string): void;
  setStatusBarHidden(hidden: boolean): void;
  getBrightness(): number;
  /** 0..1, applied immediately to the screen. Main thread only. */
  setBrightness(value: number): void;
  vibrate(): void;

  /** False once React has unmounted the view for this tag. */
  viewExists(tag: number): boolean;
  /**
   * Set a mounted view's transform directly, bypassing Fabric. Cheap enough to
   * call every frame. NOTE: invisible to React — a re-render of the view will
   * overwrite whatever is set here.
   */
  setViewTransform(
    tag: number,
    props: {
      translateX?: number;
      translateY?: number;
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      /** radians */
      rotate?: number;
    }
  ): void;
  setViewOpacity(tag: number, opacity: number): void;
}

/**
 * Resolve the module from inside a worker. Call this in worker code.
 *
 * No `{ nativeModules: true }` needed: this is a Cxx TurboModule, and the
 * lightweight Cxx-only binding is installed in EVERY worker
 * (`globalExportedCxxTurboModuleMap`, see cpp/bindings/WorkerTurboModules.h).
 * That flag opts into the heavyweight Java/ObjC TurboModule manager, which this
 * module does not need. The demo screen passes it anyway, which is harmless but
 * redundant.
 *
 * Every UI method throws if the runtime is not on the main thread, so calling
 * this from a background `Worker` fails loudly rather than corrupting UIKit
 * state. Use `UIWorker`.
 */
export function getUIWorkerDemo(): UIWorkerDemoModule {
  const get = (globalThis as any).__rnworkersGetModule;
  if (typeof get !== 'function') {
    throw new Error(
      'getUIWorkerDemo() must be called inside a worker created with ' +
        '{ nativeModules: true }.'
    );
  }
  return get('UIWorkerDemo') as UIWorkerDemoModule;
}
