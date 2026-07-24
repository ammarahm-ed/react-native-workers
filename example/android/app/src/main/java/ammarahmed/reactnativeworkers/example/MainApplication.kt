package ammarahmed.reactnativeworkers.example

import android.app.Application
import com.ammarahmed.reactnativeworkers.WorkerTurboModules
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  private val packageList: List<ReactPackage> by lazy { PackageList(this).packages }

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        packageList.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)

    // Let worker runtimes resolve this app's Java TurboModules. Hand the library
    // the same context + packages the ReactHost uses, once the context is ready.
    reactHost.addReactInstanceEventListener(
      object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          if (context is ReactApplicationContext) {
            // Hand workers the app's packages; RN core modules (incl. SourceCode)
            // are added automatically by the library.
            WorkerTurboModules.initialize(context, packageList)
          }
        }
      }
    )
  }
}
