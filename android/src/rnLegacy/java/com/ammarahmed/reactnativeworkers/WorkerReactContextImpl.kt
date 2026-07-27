package com.ammarahmed.reactnativeworkers

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

/**
 * Concrete [WorkerReactContext] for RN < 0.87.
 *
 * On these versions `ReactContext` has no abstract `getRuntimeExecutor()`, so the
 * subclass adds nothing. build.gradle includes THIS source set (`src/rnLegacy/java`)
 * only when the resolved react-native is below 0.87; the 0.87+ variant lives in
 * `src/rn87/java`. Keep the two files' constructors identical.
 */
internal class WorkerReactContextImpl(
  host: ReactApplicationContext,
  jsRuntimePointer: Long,
  workerCallInvokerHolder: CallInvokerHolder,
  deviceEventSinkId: Long,
) : WorkerReactContext(host, jsRuntimePointer, workerCallInvokerHolder, deviceEventSinkId)
