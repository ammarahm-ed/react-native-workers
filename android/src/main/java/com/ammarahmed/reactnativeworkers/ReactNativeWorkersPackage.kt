package com.ammarahmed.reactnativeworkers

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Empty React package.
 *
 * Its only job is to mark this library as NOT a "pure C++" dependency so React
 * Native autolinking includes this module's AAR — which ships the Kotlin
 * [WorkerTurboModules] bridge — on the app classpath. (Autolinking skips the
 * `.gradle`/AAR of pure-C++ dependencies.)
 *
 * The actual `ReactNativeWorkers` TurboModule is a C++ module linked into the
 * app's `appmodules` via react-native.config.js (`cmakeListsPath`), so this
 * package intentionally registers nothing.
 */
class ReactNativeWorkersPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null


  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider { emptyMap() }
}
