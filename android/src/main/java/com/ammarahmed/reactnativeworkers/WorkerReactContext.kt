package com.ammarahmed.reactnativeworkers

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.JSExceptionHandler
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.common.LifecycleState
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

/**
 * A [ReactApplicationContext] that reports **this worker's** JS runtime.
 *
 * Many libraries install their JSI bindings by asking the React context for "the"
 * runtime and installing into it once:
 *
 * ```kotlin
 * val jsContext = context.javaScriptContextHolder
 * install(jsContext.get(), context.jsCallInvokerHolder)
 * ```
 *
 * That idiom (react-native-mmkv-storage, react-native-nitro-modules, and others)
 * silently assumes one runtime per app. Handed the host context, a worker would
 * install its bindings onto the **host** global and then fail its own
 * `isLoaded()` check — the bindings are simply not on the runtime that asked for
 * them.
 *
 * Giving each worker's TurboModuleManager one of these instead means such a
 * library installs into the calling worker, with no changes on the library's
 * side. Everything except the two runtime accessors is delegated to the host
 * context, so modules keep seeing the app's real activity, lifecycle and queues.
 *
 * The message queue threads are copied from the host via `initializeFromOther`,
 * so the `runOnJSQueueThread` / `assertOnNativeModulesQueueThread` family behaves
 * exactly as it does on the main thread rather than throwing on uninitialized
 * state.
 */
internal class WorkerReactContext(
  private val host: ReactApplicationContext,
  jsRuntimePointer: Long,
  private val workerCallInvokerHolder: CallInvokerHolder,
) : ReactApplicationContext(host) {

  private val workerJsContext = JavaScriptContextHolder(jsRuntimePointer)

  init {
    // Copies the host's ReactQueueConfiguration + interop registry.
    initializeFromOther(host)
  }

  // --- the whole point: this worker's runtime, not the host's -----------------

  override fun getJavaScriptContextHolder(): JavaScriptContextHolder = workerJsContext

  override fun getJSCallInvokerHolder(): CallInvokerHolder = workerCallInvokerHolder

  /** Called when the worker is torn down, so late JSI installs cannot use a dead runtime. */
  fun invalidateRuntime() {
    workerJsContext.clear()
  }

  // --- everything else defers to the host ------------------------------------

  override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T =
    host.getJSModule(jsInterface)

  override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean =
    host.hasNativeModule(nativeModuleInterface)

  override fun getNativeModules(): Collection<NativeModule> = host.nativeModules

  override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? =
    host.getNativeModule(nativeModuleInterface)

  override fun getNativeModule(moduleName: String): NativeModule? =
    host.getNativeModule(moduleName)

  override fun getCatalystInstance(): CatalystInstance = host.catalystInstance

  @Deprecated("Use hasActiveReactInstance instead", ReplaceWith("hasActiveReactInstance()"))
  @Suppress("DEPRECATION")
  override fun hasActiveCatalystInstance(): Boolean = host.hasActiveCatalystInstance()

  override fun hasActiveReactInstance(): Boolean = host.hasActiveReactInstance()

  @Deprecated("Use hasReactInstance instead", ReplaceWith("hasReactInstance()"))
  @Suppress("DEPRECATION")
  override fun hasCatalystInstance(): Boolean = host.hasCatalystInstance()

  override fun hasReactInstance(): Boolean = host.hasReactInstance()

  @Deprecated("DO NOT USE, this method will be removed in the near future.")
  @Suppress("DEPRECATION")
  override fun isBridgeless(): Boolean = host.isBridgeless

  @Deprecated("Use UIManagerHelper.getUIManager() instead.")
  @Suppress("DEPRECATION")
  override fun getFabricUIManager(): UIManager? = host.fabricUIManager

  override fun getSourceURL(): String? = host.sourceURL

  override fun registerSegment(segmentId: Int, path: String, callback: Callback) {
    host.registerSegment(segmentId, path, callback)
  }

  override fun destroy() {
    // The host owns its own teardown; a worker context must never trigger it.
  }

  override fun handleException(e: Exception) {
    host.handleException(e)
  }

  // Activity / lifecycle state lives on the host context, so listeners registered
  // by a worker module still fire.

  override fun getCurrentActivity(): Activity? = host.currentActivity

  override fun hasCurrentActivity(): Boolean = host.hasCurrentActivity()

  override fun getLifecycleState(): LifecycleState = host.lifecycleState

  override fun addLifecycleEventListener(listener: LifecycleEventListener) {
    host.addLifecycleEventListener(listener)
  }

  override fun removeLifecycleEventListener(listener: LifecycleEventListener) {
    host.removeLifecycleEventListener(listener)
  }

  override fun getExceptionHandler(): JSExceptionHandler = host.exceptionHandler

  override fun getJSExceptionHandler(): JSExceptionHandler? = host.jsExceptionHandler

  override fun startActivityForResult(
    intent: Intent,
    code: Int,
    bundle: android.os.Bundle?,
  ): Boolean = host.startActivityForResult(intent, code, bundle)
}
