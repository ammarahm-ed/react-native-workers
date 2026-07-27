package com.ammarahmed.reactnativeworkers

import com.facebook.react.BaseReactPackage
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.common.annotations.FrameworkAPI
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.defaults.DefaultTurboModuleManagerDelegate
import com.facebook.react.internal.turbomodule.core.TurboModuleManager
import com.facebook.react.internal.turbomodule.core.TurboModuleManagerDelegate
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.turbomodule.core.CallInvokerHolderImpl
import com.facebook.react.turbomodule.core.NativeMethodCallInvokerHolderImpl

/**
 * Bridge that lets worker Hermes runtimes resolve the app's Java TurboModules.
 *
 * Android (unlike iOS) has no process-global native module registry, and RN does
 * not expose the host's live TurboModuleManagerDelegate. So the app calls
 * [initialize] once — with its [ReactApplicationContext] and the SAME
 * [ReactPackage] list it hands to the ReactHost — and we build one shared
 * [TurboModuleManagerDelegate] from it.
 *
 * Each worker then calls [installOnWorker] from C++
 * (cpp/bindings/WorkerTurboModulesAndroid.cpp) on the worker thread, passing
 * holders built around the worker's runtime + CallInvoker. Constructing the
 * [TurboModuleManager] installs `__turboModuleProxy` onto the worker runtime
 * (its `init` dispatches the binding install through the RuntimeExecutor), after
 * which worker JS resolves the app's modules through `TurboModuleRegistry`.
 */
@OptIn(FrameworkAPI::class, UnstableReactNativeAPI::class)
object WorkerTurboModules {
  @Volatile
  private var hostContext: ReactApplicationContext? = null

  /** Host packages, already denylist-filtered and with worker shims appended. */
  @Volatile
  private var workerPackages: List<ReactPackage>? = null

  /**
   * Register the app's context + packages so workers can resolve Java modules.
   * Call once (e.g. from a ReactInstanceEventListener when the context is ready).
   * Idempotent; extra calls are ignored.
   *
   * RN's built-in core modules (SourceCode, PlatformConstants, DeviceInfo, …) are
   * added automatically — see [coreReactPackage] — so you only need to pass your
   * app/third-party packages (typically `PackageList(app).packages`).
   */
  @JvmStatic
  fun initialize(context: ReactApplicationContext, packages: List<ReactPackage>) {
    if (workerPackages != null) return
    synchronized(this) {
      if (workerPackages != null) return
      val all = ArrayList<ReactPackage>()
      // Prepend RN core modules exactly as ReactInstance does for the host.
      coreReactPackage(context)?.let { all.add(it) }
      all.addAll(packages)
      hostContext = context
      // Hide worker-unsafe modules at the package level (see [DENIED_MODULES]),
      // then supply worker-safe replacements for the ones that have a shim.
      workerPackages = all.map { denyFilter(it) } + WorkerBlobPackage()
    }
  }

  /**
   * Best-effort construction of RN's internal `CoreReactPackage`, mirroring
   * `ReactInstance` (which prepends
   * `CoreReactPackage(context.devSupportManager, context.defaultHardwareBackBtnHandler)`
   * to the host's package list). That package is Kotlin-`internal`, so we build it
   * reflectively — it's a public JVM class and both context accessors are public
   * getters at the bytecode level. Returns null if RN internals differ (workers
   * then simply won't see core modules); never throws.
   */
  private fun coreReactPackage(context: ReactApplicationContext): ReactPackage? =
    try {
      val devSupportManager =
        context.javaClass.getMethod("getDevSupportManager").invoke(context)
      val backBtnHandler =
        context.javaClass.getMethod("getDefaultHardwareBackBtnHandler").invoke(context)
      val ctor =
        Class.forName("com.facebook.react.runtime.CoreReactPackage")
          .getDeclaredConstructor(
            Class.forName("com.facebook.react.devsupport.interfaces.DevSupportManager"),
            Class.forName("com.facebook.react.modules.core.DefaultHardwareBackBtnHandler"),
          )
          .apply { isAccessible = true }
      ctor.newInstance(devSupportManager, backBtnHandler) as ReactPackage
    } catch (t: Throwable) {
      android.util.Log.w(
        "RNWorkerTM",
        "RN core modules unavailable to workers (RN internals changed?): $t",
      )
      null
    }

  /**
   * Modules that assume the main JS runtime / UI thread and must not be served to
   * workers. Mirrors `isWorkerModuleDenied` in cpp/bindings/WorkerTurboModules.cpp
   * (which covers the Cxx-only path and iOS).
   *
   * Denial happens here — on the package list the delegate is built from — rather
   * than by wrapping the JS module proxy, because in bridgeless mode RN installs
   * `nativeModuleProxy` as a read-only, non-configurable global that cannot be
   * wrapped. Filtering the packages means a denied module is never constructed in
   * a worker at all, and `TurboModuleRegistry.get` simply returns null.
   *
   * `BlobModule` is denied here only so RN's own implementation never runs in a
   * worker (its `initialize()` aborts the process — see [WorkerBlobModule]);
   * [WorkerBlobPackage] immediately supplies a worker-safe replacement under the
   * same name, so `Blob` and friends still work.
   */
  private val DENIED_MODULES =
    setOf(
      "UIManager",
      "FabricUIManager",
      "SurfaceRegistry",
      "AccessibilityInfo",
      "DeviceEventManager",
      "BlobModule",
      // TimingModule resolves JSTimers through getJSModule, which is the host's
      // — so a worker's timers would be driven from the host runtime. Workers
      // have their own timers from the prelude and need this module never.
      "Timing",
    )

  /**
   * Whether [name] is denied to workers. Read by [WorkerReactContext] so its
   * native-module accessors cannot hand back the host's instance of a module that
   * was denied at the package level.
   */
  @JvmStatic
  internal fun isDenied(name: String): Boolean = name in DENIED_MODULES

  /** Wraps a package so denied module names are invisible to the delegate. */
  private fun denyFilter(pkg: ReactPackage): ReactPackage =
    when (pkg) {
      is BaseReactPackage -> FilteredBaseReactPackage(pkg)
      else -> FilteredReactPackage(pkg)
    }

  /**
   * Lazy (new-arch) packages: the delegate resolves through [getModule] and the
   * module-info map, so filtering both hides the module without instantiating it.
   */
  private class FilteredBaseReactPackage(private val inner: BaseReactPackage) :
    BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name in DENIED_MODULES) null else inner.getModule(name, reactContext)

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
      ReactModuleInfoProvider {
        inner.getReactModuleInfoProvider().getReactModuleInfos().filterKeys {
          it !in DENIED_MODULES
        }
      }
  }

  /**
   * Eager (legacy) packages: RN reads the module name from `@ReactModule` when
   * present, falling back to `NativeModule.getName()` — mirrored here so the
   * denylist matches the name the delegate would register.
   */
  private class FilteredReactPackage(private val inner: ReactPackage) : ReactPackage {
    @Suppress("DEPRECATION")
    override fun createNativeModules(
      reactContext: ReactApplicationContext
    ): List<NativeModule> =
      inner.createNativeModules(reactContext).filter { module ->
        val annotated = module.javaClass.getAnnotation(ReactModule::class.java)?.name
        (annotated ?: module.name) !in DENIED_MODULES
      }

    override fun createViewManagers(reactContext: ReactApplicationContext) =
      inner.createViewManagers(reactContext)
  }

  /**
   * Worker contexts by manager, so teardown can invalidate the one it built.
   *
   * `invalidateRuntime()` was only ever called on the Expo path, so a plain
   * `nativeModules: true` worker left a JavaScriptContextHolder wrapping a freed
   * jsi::Runtime — a late JSI install would have written into freed memory.
   */
  private val workerContexts =
    java.util.Collections.synchronizedMap(
      java.util.WeakHashMap<TurboModuleManager, WorkerReactContext>()
    )

  /**
   * Called from C++ during teardown, AFTER the manager has been invalidated and
   * while the worker runtime is still alive.
   */
  @JvmStatic
  fun onWorkerTeardown(manager: TurboModuleManager) {
    val context = workerContexts.remove(manager) ?: return
    runCatching { context.invalidateRuntime() }
    runCatching { context.detachModuleResolver() }
  }

  /** Whether [initialize] has run — probed from C++ before attempting install. */
  @JvmStatic
  fun isReady(): Boolean = workerPackages != null

  /**
   * The host [ReactApplicationContext] captured by [initialize]. Used by the Expo
   * worker bridge (WorkerExpoModules) to build a worker-bound Expo AppContext.
   * Null until the app has registered.
   */
  @JvmStatic
  internal fun hostReactContext(): ReactApplicationContext? = hostContext

  /**
   * Called from C++ on the worker thread. Builds a per-worker TurboModuleManager
   * whose construction installs the module proxy onto the worker runtime, and
   * returns it so C++ owns its lifetime (holds it, then invalidates it before the
   * worker runtime is destroyed). Returns null if the app hasn't registered.
   *
   * The delegate is built **per worker** rather than shared, so each one carries a
   * [WorkerReactContext] reporting that worker's own runtime. That is what lets
   * libraries which install JSI bindings via `context.javaScriptContextHolder`
   * work inside a worker — see [WorkerReactContext].
   *
   * @param jsRuntimePointer address of this worker's `jsi::Runtime`.
   * @param deviceEventSinkId C++ handle for this worker's device-event target, so
   *   module events are dispatched on the worker rather than on the host runtime
   *   (see [WorkerDeviceEventEmitter]).
   * @param nativeQueueId C++ handle for this worker's native-modules queue, so
   *   module method bodies and queue assertions use the worker's own thread
   *   (see [WorkerNativeQueue]).
   */
  @JvmStatic
  fun installOnWorker(
    runtimeExecutor: RuntimeExecutor,
    jsCallInvokerHolder: CallInvokerHolderImpl,
    nativeMethodCallInvokerHolder: NativeMethodCallInvokerHolderImpl,
    jsRuntimePointer: Long,
    deviceEventSinkId: Long,
    nativeQueueId: Long,
  ): TurboModuleManager? {
    val packages = workerPackages ?: return null
    val host = hostContext ?: return null
    val workerContext =
      WorkerReactContextImpl(
        host,
        jsRuntimePointer,
        jsCallInvokerHolder,
        deviceEventSinkId,
        nativeQueueId,
      )
    // The resolver is attached BEFORE the delegate is built, not after.
    //
    // Building the delegate runs `ReactPackageTurboModuleManagerDelegate.initialize`,
    // which eagerly calls `createNativeModules(workerContext)` on every non-lazy
    // (old-arch) package. Attaching afterwards meant any module whose CONSTRUCTOR
    // asked the context for a peer was handed the host's instance — the exact
    // contamination worker-local resolution exists to prevent.
    //
    // Late-bound because the manager cannot exist yet. A peer requested during
    // that window still falls back to the host — there is nothing else to resolve
    // from — but it is now logged instead of silent.
    var managerRef: TurboModuleManager? = null
    workerContext.attachModuleResolver { name ->
      val ready = managerRef
      if (ready == null) {
        android.util.Log.w(
          "RNWorkerTM",
          "peer module '$name' requested while the worker's manager was still " +
            "being built — falling back to the host's instance",
        )
        null
      } else {
        ready.getModule(name)
      }
    }

    val delegate =
      DefaultTurboModuleManagerDelegate.Builder()
        .setPackages(packages)
        .setReactApplicationContext(workerContext)
        .build()
    val manager =
      TurboModuleManager(
        runtimeExecutor,
        delegate,
        jsCallInvokerHolder,
        nativeMethodCallInvokerHolder,
      )
    // Close the late binding: from here every peer lookup resolves worker-locally.
    managerRef = manager
    workerContexts[manager] = workerContext
    return manager
  }
}
