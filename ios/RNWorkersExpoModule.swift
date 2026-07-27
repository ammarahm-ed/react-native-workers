// Companion Expo module whose ONLY job is to capture the app's EXAppContext and
// hand it to the worker Expo-modules installer (RNWorkersExpoBridge). Expo's own
// dependency injection constructs this with the app's AppContext, which is the
// cleanest way to obtain it — no app-side wiring required.
//
// Autolinked ONLY in Expo apps (via expo-module.config.json); bare React Native
// apps never see it.
import ExpoModulesCore

public class RNWorkersExpoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RNWorkersExpo")

    OnCreate {
      // `appContext` is this module's AppContext — the app's running context.
      RNWorkersExpoBridge.registerAppContext(self.appContext)
      #if RNWORKERS_EXPO_SWIFT_JSI
      // SDK 56+: the installer reaches Expo's JSI through Swift (see
      // RNWorkersExpoJSI) because the ObjC JSI classes no longer exist.
      RNWorkersExpoJSI.setAppContext(self.appContext)
      #endif
    }
  }
}
