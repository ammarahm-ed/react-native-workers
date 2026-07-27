// Expo SDK 56+ bridge: hand the ObjC++ worker installer raw `jsi` pointers.
//
// Up to SDK 55 the installer could reach the main runtime and a module's JS
// object through Expo's ObjC JSI classes (EXJavaScriptRuntime / EXJavaScriptObject).
// SDK 56 rewrote those in Swift (the `ExpoModulesJSI` package), and Swift cannot
// re-expose them over @objc because their APIs traffic in C++ types
// (`jsi::Object`, `std::shared_ptr<CallInvoker>`) — so the ObjC++ path is closed.
//
// What IS public on the Swift types is `withUnsafePointee`, which yields the
// underlying C++ pointer. That is the whole trick here: this file does the Expo
// lookup in Swift, then calls back into ObjC++ with `jsi::Runtime *` and
// `jsi::Object *`, letting the existing installer keep working untouched instead
// of reimplementing marshalling, calls and the event bridge against a new API.
//
// Gated by RNWORKERS_EXPO_SWIFT_JSI, set in the podspec when expo-modules-jsi is
// a STANDALONE package (SDK 56+). canImport() cannot be used: SDK 55 bundles an
// ExpoModulesJSI pod too, but with the old ObjC-backed API. SDK 54/55 keep the ObjC
// header path in WorkerExpoModules.mm and never reference this class.
#if RNWORKERS_EXPO_SWIFT_JSI

import ExpoModulesCore
import ExpoModulesJSI

@objc(RNWorkersExpoJSI)
public final class RNWorkersExpoJSI: NSObject {
  /// Weak: a host reload tears the AppContext down, and we must not keep it alive.
  private static weak var appContext: AppContext?

  /// Called by RNWorkersExpoModule's OnCreate, alongside RNWorkersExpoBridge.
  @objc(setAppContext:)
  public static func setAppContext(_ context: AnyObject?) {
    appContext = context as? AppContext
  }

  /// True when SDK 56+ Expo JSI access is wired up. The installer uses this to
  /// decide between this path and the legacy ObjC one.
  @objc(isAvailable)
  public static var isAvailable: Bool {
    return appContext != nil
  }

  /// Runs `body` on Expo's JavaScript actor with the MAIN runtime pointer.
  ///
  /// `body` receives a `jsi::Runtime *`. Scheduling is Expo's own — the closure
  /// runs where Expo expects main-runtime work to happen, which is what makes
  /// touching the module objects safe.
  @objc(withMainRuntime:)
  public static func withMainRuntime(_ body: @escaping (UnsafeMutableRawPointer) -> Void) {
    guard let appContext, let runtime = try? appContext.runtime else {
      return
    }
    runtime.schedule {
      runtime.withUnsafePointee { runtimePointer in
        body(runtimePointer)
      }
    }
  }

  /// Resolves a module's JS object on the main runtime and hands it to `body` as
  /// `jsi::Runtime *` plus `jsi::Object *` (null when the module is absent or is
  /// not an object). Runs on Expo's JavaScript actor.
  @objc(withModuleObject:body:)
  public static func withModuleObject(
    _ moduleName: String,
    _ body: @escaping (UnsafeMutableRawPointer, UnsafeRawPointer?) -> Void
  ) {
    guard let appContext, let runtime = try? appContext.runtime else {
      return
    }
    runtime.schedule {
      runtime.withUnsafePointee { runtimePointer in
        guard let value = appContext.getNativeModuleObject(moduleName), value.isObject() else {
          body(runtimePointer, nil)
          return
        }
        let object = value.getObject()
        object.withUnsafePointee { objectPointer in
          body(runtimePointer, objectPointer)
        }
      }
    }
  }

  /// Module discovery, mirroring the @objc AppContext calls the installer already
  /// makes on older SDKs.
  @objc(moduleNames)
  public static func moduleNames() -> [String] {
    return appContext?.getModuleNames() ?? []
  }

  @objc(hasModule:)
  public static func hasModule(_ name: String) -> Bool {
    return appContext?.hasModule(name) ?? false
  }
}

#endif // RNWORKERS_EXPO_SWIFT_JSI
