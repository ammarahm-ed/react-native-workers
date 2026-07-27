package com.ammarahmed.reactnativeworkers

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

/**
 * Concrete [WorkerReactContext] for RN >= 0.87.
 *
 * RN 0.87 added an abstract `ReactContext.getRuntimeExecutor(): RuntimeExecutor?`.
 * We delegate it to the host — consistent with how [WorkerReactContext] already
 * delegates `getCatalystInstance()` to the host (the host's catalystInstance is
 * where a runtime executor would otherwise come from). build.gradle includes THIS
 * source set (`src/rn87/java`) only when the resolved react-native is >= 0.87; the
 * legacy variant lives in `src/rnLegacy/java`. Keep the two constructors identical.
 */
internal class WorkerReactContextImpl(
  host: ReactApplicationContext,
  jsRuntimePointer: Long,
  workerCallInvokerHolder: CallInvokerHolder,
  deviceEventSinkId: Long,
  nativeQueueId: Long,
) : WorkerReactContext(
  host,
  jsRuntimePointer,
  workerCallInvokerHolder,
  deviceEventSinkId,
  nativeQueueId,
) {

  /**
   * NOT the host's executor.
   *
   * `getJavaScriptContextHolder()` and `getJSCallInvokerHolder()` are overridden
   * precisely because "ask the context for the runtime and install once" must
   * target the worker. `getRuntimeExecutor()` is the modern spelling of that same
   * idiom, so delegating it handed a worker module the HOST runtime on the RN JS
   * thread — breaking both isolation rules, silently, only on 0.87+.
   *
   * Null until the worker's executor is plumbed through from C++
   * (buildPlatformManager already constructs one). Null is the honest answer: RN
   * declares this nullable, callers must handle it, and no-executor fails loudly
   * where wrong-executor corrupts quietly.
   */
  override fun getRuntimeExecutor(): RuntimeExecutor? {
    android.util.Log.w(
      "RNWorkerTM",
      "getRuntimeExecutor() is not yet worker-bound; returning null rather than " +
        "the host's executor (would install onto the host runtime)",
    )
    return null
  }
}
