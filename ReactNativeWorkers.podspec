require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# EXPERIMENTAL: detect whether this is an Expo app (ExpoModulesCore available). If
# so, compile the optional Expo-modules-in-worker integration (the companion Swift
# module + the ObjC++ installer that needs <ExpoModulesCore/...> headers). Bare
# React Native apps skip all of it — the installer's `__has_include` guard makes
# WorkerExpoModules.mm a no-op there, and the Swift file isn't compiled at all.
expo_modules_core_available = begin
  resolved = `node --print "require.resolve('expo-modules-core/package.json')" 2>/dev/null`.strip
  !resolved.empty?
rescue StandardError
  false
end

# Expo SDK 55 moved the ObjC JSI headers (EXJavaScriptRuntime/Object/Value,
# EXJSIConversions, EXJSIUtils, JSIUtils) out of ExpoModulesCore and into a
# sibling `ExpoModulesJSI` pod — ExpoModulesCore.podspec now does
# `exclude_files: ['ios/JSI', …]`. Depend on that pod when it exists so
# <ExpoModulesJSI/...> is on the header search path; SDK 54 has no such pod and
# keeps its <ExpoModulesCore/...> imports. The podspec ships INSIDE
# expo-modules-core on SDK 55, and as its own `expo-modules-jsi` package later.
expo_modules_jsi_standalone = begin
  !`node --print "require.resolve('expo-modules-jsi/package.json')" 2>/dev/null`.strip.empty?
rescue StandardError
  false
end

expo_modules_jsi_available = begin
  core = `node --print "require.resolve('expo-modules-core/package.json')" 2>/dev/null`.strip
  in_core = !core.empty? && File.exist?(File.join(File.dirname(core), "ExpoModulesJSI.podspec"))
  in_core || expo_modules_jsi_standalone
rescue StandardError
  false
end

Pod::Spec.new do |s|
  s.name         = "ReactNativeWorkers"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/ammarahm-ed/ammarahmed-react-native-workers.git", :tag => "#{s.version}" }

  source_files = ["ios/**/*.{h,m,mm}", "cpp/**/*.{hpp,cpp,c,h}", "ios/generated/*.{h,cpp,mm}"]

  # Create a second Hermes runtime via hermes::makeHermesRuntime (needs
  # <hermes/hermes.h> from the hermes-engine pod), and a per-worker
  # RCTTurboModuleManager from React-NativeModulesApple for platform modules.
  s.dependency "hermes-engine"
  s.dependency "React-NativeModulesApple"

  # Worker runtimes register themselves as debuggable CDP targets
  # (cpp/runtime/WorkerInspector.cpp). Hermes only ships the CDP symbols in a
  # debugger-enabled build, so — exactly as React Native does for React-hermes
  # and React-RuntimeHermes — the code is compiled in for Debug only. Without
  # this the Release link fails on undefined hermes::cdp::* symbols.
  debugger_xcconfig = {
    "GCC_PREPROCESSOR_DEFINITIONS[config=Debug]" => "$(inherited) HERMES_ENABLE_DEBUGGER=1",
  }

  if expo_modules_core_available
    # Compile the companion Expo module (captures the app AppContext) and give the
    # pod the ExpoModulesCore headers the worker installer needs. DEFINES_MODULE +
    # the public bridge header let the Swift module call into the ObjC++ bridge.
    source_files << "ios/**/*.swift"
    s.dependency "ExpoModulesCore"
    # SDK 55+: the ObjC JSI headers live here (see the detection above).
    s.dependency "ExpoModulesJSI" if expo_modules_jsi_available
    s.public_header_files = "ios/RNWorkersExpoBridge.h"
    # `canImport(ExpoModulesJSI)` cannot tell SDK 55 from 56+: 55 bundles that pod
    # inside expo-modules-core with the OLD ObjC-backed API, while 56+ ships it as
    # its own package with the Swift rewrite. Only the standalone package has the
    # `withUnsafePointee` surface RNWorkersExpoJSI.swift needs, so gate that file
    # on a flag resolved here — the same version-selection idea android/build.gradle
    # uses to pick an RN source set.
    expo_swift_jsi_flags = expo_modules_jsi_standalone ? " RNWORKERS_EXPO_SWIFT_JSI" : ""
    # The same switch is needed by BOTH languages: Swift gates RNWorkersExpoJSI.swift,
    # ObjC++ gates WorkerExpoModulesSwiftJSI.mm (the SDK 56+ installer).
    expo_swift_jsi_define =
      expo_modules_jsi_standalone ? " RNWORKERS_EXPO_SWIFT_JSI=1" : ""
    s.pod_target_xcconfig = debugger_xcconfig.merge({
      "DEFINES_MODULE" => "YES",
      "SWIFT_VERSION" => "5.0",
      "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "$(inherited)#{expo_swift_jsi_flags}",
      "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited)#{expo_swift_jsi_define}",
    })
  else
    s.private_header_files = "ios/**/*.h"
    s.pod_target_xcconfig = debugger_xcconfig
  end

  s.source_files = source_files

  # `ios/**/*` is recursive, so it would also swallow the codegen BUILD output
  # under ios/generated/build/ — which contains ReactNativeWorkersSpec-generated.mm,
  # the very file React Native's own ReactCodegen pod compiles. Linking both
  # copies fails with duplicate symbols for NativeReactNativeWorkersSpecBase.
  #
  # That directory only exists after `yarn prepare` / `bob build --target codegen`,
  # so without this exclusion iOS builds break for anyone who runs codegen and
  # then `pod install` — and keep working for everyone who does not, which makes
  # it a nasty one to track down.
  s.exclude_files = "ios/generated/build/**/*"

  install_modules_dependencies(s)
end
