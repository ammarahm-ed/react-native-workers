// A real, per-worker Expo `AppContext` on iOS.
//
// Previously a worker got a forwarding host object: `global.expo.modules` in the
// worker runtime proxied every call to the app's single AppContext, whose module
// JS objects live on the MAIN runtime. That worked, but it broke both isolation
// rules — module events were bridged off the main runtime, live property reads
// blocked the worker on the main JS thread, and every worker shared the app's
// module instances.
//
// None of that is necessary. Everything needed to give a worker its own context is
// public in ExpoModulesCore:
//
//   * `AppContext()`                — a fresh context
//   * `useModulesProvider(_:)`      — populate it from the app's generated provider
//   * `_runtime` (@objc, settable)  — assigning it runs `prepareRuntime()`, which
//                                     installs `global.expo`, the EventEmitter /
//                                     SharedObject / SharedRef / NativeModule
//                                     classes and the `expo.modules` host object
//                                     against THAT runtime
//
// So the worker gets Expo's real implementation, built against the worker runtime:
// its own module instances, functions, events and properties — all native, all on
// the worker's thread, with the main runtime never involved.
//
// The runtime object itself is built on the ObjC++ side (`EXJavaScriptRuntime`'s
// pointer-taking initializer is inside `#ifdef __cplusplus`, so Swift can't see
// it) and handed here as `AnyObject`. This class exists because the other three
// steps are Swift-only: `AppContext.init` and `useModulesProvider` are not
// `@objc`-exposed.
//
// Autolinked only in Expo apps, like the rest of ios/*.swift.
// SDK 56+ made `AppContext._runtime` private and replaced it with a public
// `setRuntime(_:scheduler:dispatch:)` taking a raw pointer, so the code below
// cannot compile there — it broke the build outright for SDK 55/56/57 apps, on
// every RN version, because this class was only ever verified against SDK 54.
//
// Those SDKs do not use this class: the ObjC++ side that builds an
// `EXJavaScriptRuntime` is itself compiled out when the JSI API is Swift-only, and
// SDK 56+ installs Expo through RNWorkersExpoJSI/WorkerExpoModulesSwiftJSI.mm
// instead. So keep the `@objc` surface (the ObjC++ lookup is by name and must
// still resolve) and decline, which is exactly what the caller already handles by
// falling back to the forwarding installer.
//
// Adopting `setRuntime` to give SDK 56+ a real per-worker AppContext is worth
// doing, but it needs its own device verification per SDK — not a compile fix.
#if RNWORKERS_EXPO_SWIFT_JSI

import ExpoModulesCore

@objc(RNWorkersExpoWorkerContext)
public final class RNWorkersExpoWorkerContext: NSObject {
  @objc(createWithRuntime:)
  public static func create(runtime: AnyObject) -> RNWorkersExpoWorkerContext? {
    return nil
  }

  @objc(hasModules)
  public var hasModules: Bool { return false }

  @objc(invalidate)
  public func invalidate() {}
}

#else

import ExpoModulesCore

@objc(RNWorkersExpoWorkerContext)
public final class RNWorkersExpoWorkerContext: NSObject {
  /// Kept alive for the worker's lifetime; released by `invalidate()`.
  private let appContext: AppContext

  private init(appContext: AppContext) {
    self.appContext = appContext
  }

  /// Builds a context bound to `runtime` (an `EXJavaScriptRuntime` created around
  /// the worker's `jsi::Runtime` + CallInvoker). Returns nil if the object isn't a
  /// runtime this SDK understands, in which case the caller keeps the legacy
  /// forwarding installer.
  @objc(createWithRuntime:)
  public static func create(runtime: AnyObject) -> RNWorkersExpoWorkerContext? {
    guard let expoRuntime = runtime as? ExpoRuntime else {
      // Distinct from the `global.expo` failure below: this one means the caller
      // handed us the wrong runtime class, which read as an SDK-compat gap for a
      // whole day. Never collapse the two into one untagged nil again.
      NSLog("[RNWorkerExpo] worker context: runtime is %@, not ExpoRuntime",
            String(describing: type(of: runtime)))
      return nil
    }
    let appContext = AppContext()
    _ = appContext.useModulesProvider("ExpoModulesProvider")

    // Assigning the runtime is what installs Expo into it (`prepareRuntime`).
    // Anything that throws in there is swallowed by Expo's own `try?`, so verify
    // the result rather than trusting it: without `global.expo` the worker would
    // silently have a context that answers nothing.
    appContext._runtime = expoRuntime
    guard expoRuntime.global().hasProperty("expo") else {
      NSLog("[RNWorkerExpo] worker context: prepareRuntime() left no global.expo")
      appContext._runtime = nil
      return nil
    }
    return RNWorkersExpoWorkerContext(appContext: appContext)
  }

  /// Whether the app's generated provider resolved any modules. A context with an
  /// empty registry means the provider class wasn't found, which is worth falling
  /// back on rather than shipping a worker where every import returns nothing.
  @objc(hasModules)
  public var hasModules: Bool {
    return !appContext.getModuleNames().isEmpty
  }

  /// Runs on the worker thread while its runtime is still alive. Unsetting the
  /// runtime is what makes Expo release every JS object it holds for this
  /// context — skipping it leaves JSI values to be destroyed after the runtime.
  @objc(invalidate)
  public func invalidate() {
    appContext._runtime = nil
  }
}

#endif
