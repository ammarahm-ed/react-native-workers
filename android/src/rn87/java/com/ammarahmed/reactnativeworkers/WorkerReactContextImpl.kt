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
) : WorkerReactContext(host, jsRuntimePointer, workerCallInvokerHolder) {

  override fun getRuntimeExecutor(): RuntimeExecutor? = host.runtimeExecutor
}
