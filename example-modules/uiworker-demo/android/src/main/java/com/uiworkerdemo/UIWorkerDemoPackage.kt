package com.uiworkerdemo

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.soloader.SoLoader

/**
 * Registers nothing with React Native — `UIWorkerDemo` is a C++ TurboModule that
 * puts itself in RN's global Cxx module map, so it is resolvable from any
 * runtime without ever passing through a ReactPackage.
 *
 * This class exists for one side effect that has no other hook on Android:
 * **loading the native library.** iOS gets `+load` (see UIWorkerDemoIOS.mm);
 * Android has no equivalent, so something on the Java side has to pull the
 * library in, at which point `JNI_OnLoad` installs the platform and registers
 * the module. Autolinking instantiates this package while React Native builds
 * its package list, which is comfortably before any worker can be created — and
 * unlike `getModule`, the constructor is guaranteed to run for a package that
 * registers nothing.
 *
 * The Activity the platform layer needs comes from [UIWorkerDemoInitProvider],
 * not from here, so nothing depends on this package being consulted.
 */
class UIWorkerDemoPackage : BaseReactPackage() {
  init {
    SoLoader.loadLibrary("uiworkerdemo")
  }

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider { emptyMap() }
}
