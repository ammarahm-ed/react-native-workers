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
import com.facebook.react.module.annotations.ReactModule
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
 *
 * RN cross-version note: RN 0.87 added a new abstract
 * `ReactContext.getRuntimeExecutor(): RuntimeExecutor?` that does NOT exist on
 * 0.81–0.86, so `override fun getRuntimeExecutor()` can't live here (it would fail
 * to compile across the whole supported range). This class is therefore `abstract`;
 * the concrete [WorkerReactContextImpl] lives in one of two RN-version-selected
 * source sets (`src/rn87/java` vs `src/rnLegacy/java`, chosen in build.gradle) —
 * the 0.87+ variant overrides `getRuntimeExecutor()`, the legacy one doesn't.
 * Construct via `WorkerReactContextImpl(...)`, never this class directly.
 */
internal abstract class WorkerReactContext(
  protected val host: ReactApplicationContext,
  jsRuntimePointer: Long,
  private val workerCallInvokerHolder: CallInvokerHolder,
  deviceEventSinkId: Long,
  private val nativeQueueId: Long,
) : ReactApplicationContext(host) {

  private val workerJsContext = JavaScriptContextHolder(jsRuntimePointer)

  /** This worker's own device-event target — see [WorkerDeviceEventEmitter]. */
  private val deviceEventEmitter = WorkerDeviceEventEmitter(deviceEventSinkId)

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

  // --- native-modules queue: this worker's, not the host's --------------------
  //
  // A worker's module method bodies run on its own C++ queue thread
  // ([WorkerNativeQueue]), so RN's queue questions have to be answered about that
  // thread. Left to the host they would assert against the host's native queue —
  // which a worker thread is never on, breaking every module that calls
  // `assertOnNativeModulesQueueThread()` — and `runOnNativeModulesQueueThread`
  // would hand the work to a thread shared with the host.

  override fun isOnNativeModulesQueueThread(): Boolean =
    WorkerNativeQueue.isOnQueue(nativeQueueId) || super.isOnNativeModulesQueueThread()

  override fun assertOnNativeModulesQueueThread() {
    if (!isOnNativeModulesQueueThread()) super.assertOnNativeModulesQueueThread()
  }

  override fun assertOnNativeModulesQueueThread(message: String) {
    if (!isOnNativeModulesQueueThread()) super.assertOnNativeModulesQueueThread(message)
  }

  override fun runOnNativeModulesQueueThread(runnable: Runnable) {
    if (nativeQueueId != 0L) {
      WorkerNativeQueue.post(nativeQueueId, runnable)
    } else {
      super.runOnNativeModulesQueueThread(runnable)
    }
  }

  // --- everything else defers to the host ------------------------------------

  /**
   * Device events are served from THIS worker; everything else still defers to the
   * host.
   *
   * `ReactContext.emitDeviceEvent` — and the `getJSModule(RCTDeviceEventEmitter)`
   * idiom modules use directly — resolve here. Returning the worker's own emitter
   * keeps a worker module's events off the host runtime and off the RN JS thread
   * entirely (see [WorkerDeviceEventEmitter]); delegating them to the host, as the
   * other overrides do, would round-trip and copy every event.
   *
   * Other JS modules (HMRClient, AppRegistry, …) have no worker counterpart and are
   * still the host's.
   */
  @Suppress("UNCHECKED_CAST")
  override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T =
    if (deviceEventEmitter.serves(jsInterface)) {
      deviceEventEmitter.proxyFor(jsInterface) as T
    } else {
      host.getJSModule(jsInterface)
    }

  // --- peer native modules: this worker's instances, not the host's -----------
  //
  // Modules reach for each other through the context. Answered by the host, a
  // worker module would be handed the HOST's instance of its peer — a live object
  // bound to the host runtime, shared with the main app, and not built for this
  // worker's thread. Resolving through the worker's own TurboModuleManager keeps a
  // worker's module graph entirely its own.
  //
  // Falls back to the host when there is no worker manager (Cxx-only workers, and
  // the Expo AppContext path) or when the name isn't one of the worker's.

  /** Set once the worker's TurboModuleManager exists (see WorkerTurboModules). */
  @Volatile
  private var moduleResolver: ((String) -> NativeModule?)? = null

  /** Names currently being resolved on this thread — see [workerModule]. */
  private val resolving = ThreadLocal.withInitial { HashSet<String>() }

  internal fun attachModuleResolver(resolver: (String) -> NativeModule?) {
    moduleResolver = resolver
  }

  /**
   * A worker-local module by name, or null.
   *
   * Guarded against re-entrancy: resolving a module constructs it, and a
   * constructor that asks the context for a peer would otherwise re-enter the
   * manager for a name already in flight. Inside such a cycle we defer to the
   * host rather than deadlock or recurse.
   */
  private fun workerModule(name: String): NativeModule? {
    val resolver = moduleResolver ?: return null
    val inFlight = resolving.get() ?: return null
    if (!inFlight.add(name)) return null
    return try {
      resolver(name)
    } catch (t: Throwable) {
      // Never silent: "construction failed" and "not one of ours" are different
      // facts, and the caller is about to be handed the HOST's instance instead.
      android.util.Log.w("RNWorkerTM", "worker module '$name' failed to build: $t")
      null
    } finally {
      inFlight.remove(name)
    }
  }

  /**
   * The name RN registers a module class under.
   *
   * `@ReactModule` first, falling back to the class's simple name. Most old-arch
   * modules carry no annotation, and returning null for those meant they never
   * even attempted worker-local resolution — they went straight to the host.
   */
  private fun moduleNameOf(cls: Class<*>): String? =
    cls.getAnnotation(ReactModule::class.java)?.name ?: cls.simpleName

  /**
   * Whether a name is denied to workers (UIManager, SurfaceRegistry, …).
   *
   * The denylist stops JS resolution, but these accessors used to fall through to
   * the host on a miss — handing a worker module the host's live UIManager,
   * callable from the worker's JS thread or its native queue. That is precisely
   * what denial exists to prevent, so denied names resolve to nothing here rather
   * than to the host's instance.
   */
  private fun isDeniedForWorkers(name: String?): Boolean =
    name != null && WorkerTurboModules.isDenied(name)

  override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean {
    val name = moduleNameOf(nativeModuleInterface)
    if (isDeniedForWorkers(name)) return false
    return (name?.let { workerModule(it) != null } == true) ||
      host.hasNativeModule(nativeModuleInterface)
  }

  // The worker's manager builds modules lazily, so it has no meaningful "all
  // modules" answer; this stays the host's list.
  override fun getNativeModules(): Collection<NativeModule> = host.nativeModules

  @Suppress("UNCHECKED_CAST")
  override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? {
    val name = moduleNameOf(nativeModuleInterface)
    if (isDeniedForWorkers(name)) return null
    if (name != null) {
      val worker = workerModule(name)
      if (worker != null && nativeModuleInterface.isInstance(worker)) {
        return worker as T
      }
    }
    return host.getNativeModule(nativeModuleInterface)
  }

  override fun getNativeModule(moduleName: String): NativeModule? {
    if (isDeniedForWorkers(moduleName)) return null
    return workerModule(moduleName) ?: host.getNativeModule(moduleName)
  }

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
  // A worker has no view hierarchy; handing back the host's UIManager would let
  // worker code touch views off the UI thread (see isDeniedForWorkers).
  override fun getFabricUIManager(): UIManager? = null

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
