package ammarahmed.reactnativeworkers.example

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Exposes [TestHttpServerModule] to the host runtime. Test-support only. */
class TestHttpServerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == TestHttpServerModule.NAME) TestHttpServerModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      TestHttpServerModule.NAME to
        ReactModuleInfo(
          TestHttpServerModule.NAME,
          TestHttpServerModule.NAME,
          /* canOverrideExistingModule = */ false,
          /* needsEagerInit = */ false,
          /* isCxxModule = */ false,
          // A legacy module: resolved through RN's TurboModule interop layer,
          // which is what makes its @ReactMethod methods callable from JS.
          /* isTurboModule = */ false,
        )
    )
  }
}
