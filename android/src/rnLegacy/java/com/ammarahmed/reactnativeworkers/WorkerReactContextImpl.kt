package com.ammarahmed.reactnativeworkers

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

/**
 * Concrete [WorkerReactContext] for RN < 0.87.
 *
 * On these versions `ReactContext` has no `getRuntimeExecutor()` to override, so the
 * subclass adds nothing — it still takes the worker executor to keep the two
 * constructors interchangeable, and the base simply never hands it out here.
 * build.gradle includes THIS source set (`src/rnLegacy/java`)
 * only when the resolved react-native is below 0.87; the 0.87+ variant lives in
 * `src/rn87/java`. Keep the two files' constructors identical.
 */
internal class WorkerReactContextImpl(
  host: ReactApplicationContext,
  jsRuntimePointer: Long,
  workerCallInvokerHolder: CallInvokerHolder,
  deviceEventSinkId: Long,
  nativeQueueId: Long,
  workerRuntimeExecutor: RuntimeExecutor?,
) : WorkerReactContext(
  host,
  jsRuntimePointer,
  workerCallInvokerHolder,
  deviceEventSinkId,
  nativeQueueId,
  workerRuntimeExecutor,
)
