package com.ammarahmed.reactnativeworkers

import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.common.annotations.FrameworkAPI
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.turbomodule.core.CallInvokerHolderImpl
import expo.modules.kotlin.ExpoModulesHelper
import expo.modules.kotlin.KotlinInteropModuleRegistry
import java.lang.ref.WeakReference

/**
 * Builds a per-worker Expo [expo.modules.kotlin.AppContext] bound to a worker
 * Hermes runtime and installs `global.expo` into it via Expo's own JSI install —
 * so Expo modules run **natively** inside the worker (functions sync+async,
 * events, properties, binary), reusing Expo's implementation rather than any
 * forwarding shim of ours.
 *
 * This file lives in a conditionally-compiled source set (`src/expo/java`) that is
 * only added when the consumer resolves `expo-modules-core`. Non-Expo apps never
 * compile or ship it, and the C++ installer (WorkerExpoModulesAndroid.cpp) simply
 * fails to find this class and no-ops.
 *
 * Called from C++ on the worker JS thread (inside `ThreadScope::WithClassLoader`).
 *
 * Cross-SDK note: the AppContext construction + module registry API
 * (`KotlinInteropModuleRegistry`, `ExpoModulesHelper.modulesProvider`, the legacy
 * `ModuleRegistry`, `emitOnCreate`/`onDestroy`, the runtime's `jsiContext` field)
 * is stable across Expo SDK 54–57. The ONE piece Expo rewrote is the JSI-install
 * call — SDK 54–56 use `JSIContext().installJSIForBridgeless(runtime, ptr, exec)`,
 * SDK 57 uses `MainRuntimeInstaller(runtime).install(ptr, exec)`. We can't compile
 * against symbols absent from some SDKs, so [installJsiForWorkerRuntime] dispatches
 * to whichever exists via reflection (and no-ops cleanly on a future SDK whose API
 * differs again — the build stays green, the worker just has no `global.expo`).
 */
@OptIn(FrameworkAPI::class, UnstableReactNativeAPI::class)
object WorkerExpoModules {

  /** Opaque handle returned to C++ and passed back to [teardown]. */
  private class Handle(
    val interop: KotlinInteropModuleRegistry,
    val jsiContext: Any?, // expo.modules.kotlin.jni.JSIContext (AutoCloseable); typed Any to stay SDK-agnostic
    val workerContext: WorkerReactContext,
  )

  /**
   * True only when this is an Expo app (the generated module provider resolves)
   * AND the host React context was captured (WorkerTurboModules.initialize ran).
   * Probed from C++ so non-Expo apps are a clean no-op rather than an exception.
   */
  @JvmStatic
  fun isReady(): Boolean =
    WorkerTurboModules.hostReactContext() != null &&
      ExpoModulesHelper.modulesProvider != null

  /**
   * Build the worker AppContext and install `global.expo` against the worker
   * runtime. Returns an opaque handle (held by C++, passed back to [teardown]) or
   * null on failure. Runs on the worker JS thread.
   */
  @JvmStatic
  fun installOnWorker(
    runtimeExecutor: RuntimeExecutor,
    callInvokerHolder: CallInvokerHolderImpl,
    jsRuntimePointer: Long,
    deviceEventSinkId: Long,
    nativeQueueId: Long,
  ): Any? {
    val host = WorkerTurboModules.hostReactContext() ?: return null
    val modulesProvider = ExpoModulesHelper.modulesProvider ?: return null

    return try {
      // Fresh legacy registry — AppContext.init adds FilePermission /
      // AppDirectories itself (those back cacheDir/documentsDir). We seed it with a
      // legacy EventEmitter service so `Module.sendEvent` works: without one,
      // `appContext.eventEmitter(module)` is null and events silently no-op (module
      // events actually emit through the JSI path to the worker runtime — this is
      // just the required gate). See [WorkerLegacyEventEmitter].
      val legacyRegistry = expo.modules.core.ModuleRegistry(
        listOf(WorkerLegacyEventEmitter()),
        emptyList(),
      )

      // A React context reporting THIS worker's runtime + invoker. CoreModule only
      // needs an Android Context (cacheDir/filesDir), which delegates to the host.
      val workerContext =
        WorkerReactContextImpl(
          host,
          jsRuntimePointer,
          callInvokerHolder,
          deviceEventSinkId,
          nativeQueueId,
          runtimeExecutor,
        )

      val interop = KotlinInteropModuleRegistry(
        modulesProvider,
        legacyRegistry,
        WeakReference(workerContext),
      )
      runCatching { legacyRegistry.ensureIsInitialized() }

      val appContext = interop.appContext
      // RuntimeContext (SDK 54–56) / MainRuntime (SDK 57) — treat as Any for reflection.
      val runtimeContext: Any = appContext.hostingRuntimeContext

      // Install Expo's JSI against the WORKER runtime + WORKER executor. Expo's own
      // install path hardwires the HOST catalystInstance, so we drive the version's
      // installer directly (reflection) and back-fill the runtime's `jsiContext`.
      val jsiContext = installJsiForWorkerRuntime(runtimeContext, jsRuntimePointer, runtimeExecutor)
        ?: run {
          android.util.Log.w(
            "RNWorkerExpo",
            "no known Expo JSI installer on this SDK — global.expo not installed in worker",
          )
          return null
        }
      interop.emitOnCreate()

      android.util.Log.i("RNWorkerExpo", "worker AppContext installed (global.expo ready)")
      Handle(interop, jsiContext, workerContext)
    } catch (t: Throwable) {
      android.util.Log.w("RNWorkerExpo", "installOnWorker failed: $t", t)
      null
    }
  }

  /**
   * Installs Expo's JSI into the worker runtime, dispatching by SDK via reflection
   * (see class doc). Also sets the runtime's `internal lateinit jsiContext` field —
   * read by SharedObject registration + event emission. Returns the JSIContext, or
   * null if no known installer matched.
   */
  private fun installJsiForWorkerRuntime(
    runtimeContext: Any,
    jsRuntimePointer: Long,
    runtimeExecutor: RuntimeExecutor,
  ): Any? {
    // SDK 57+: MainRuntimeInstaller(mainRuntime).install(ptr, RuntimeExecutor): JSIContext
    runCatching {
      val cls = Class.forName("expo.modules.kotlin.jni.MainRuntimeInstaller")
      val installer = cls.constructors.first { it.parameterCount == 1 }.newInstance(runtimeContext)
      val install = cls.methods.first {
        it.name == "install" &&
          it.parameterTypes.size == 2 &&
          it.parameterTypes[0] == java.lang.Long.TYPE &&
          it.parameterTypes[1].name == "com.facebook.react.bridge.RuntimeExecutor"
      }
      val jsiContext = install.invoke(installer, jsRuntimePointer, runtimeExecutor)
      setRuntimeJsiContextField(runtimeContext, jsiContext)
      return jsiContext
    }
    // SDK 54–56: JSIContext().installJSIForBridgeless(runtime, ptr, RuntimeExecutor)
    runCatching {
      val jsiCls = Class.forName("expo.modules.kotlin.jni.JSIContext")
      val jsiContext = jsiCls.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
      setRuntimeJsiContextField(runtimeContext, jsiContext)
      val install = jsiCls.methods.first {
        it.name == "installJSIForBridgeless" && it.parameterTypes.size == 3
      }
      install.invoke(jsiContext, runtimeContext, jsRuntimePointer, runtimeExecutor)
      return jsiContext
    }
    return null
  }

  /** Back-fills the runtime's `internal lateinit jsiContext` field (no external setter). */
  private fun setRuntimeJsiContextField(runtimeContext: Any, jsiContext: Any?) {
    runCatching {
      val field = runtimeContext.javaClass.getDeclaredField("jsiContext")
      field.isAccessible = true
      field.set(runtimeContext, jsiContext)
    }
  }

  /**
   * Release the per-worker AppContext. MUST run on the worker JS thread (unbinds
   * the worker runtime's JSIContext via a thread-local map). Called from C++
   * setPreDestroy while the runtime is still alive.
   */
  @JvmStatic
  fun teardown(handle: Any) {
    val h = handle as? Handle ?: return
    // onDestroy first (MODULE_DESTROY, cancels queues, runtime.deallocate), then
    // free the JSIContext ourselves — deallocate does not, and we own it (we set
    // the field by reflection). JSIContext is AutoCloseable across SDKs.
    runCatching { h.interop.onDestroy() }
    runCatching { (h.jsiContext as? AutoCloseable)?.close() }
    runCatching { h.workerContext.invalidateRuntime() }
  }
}
