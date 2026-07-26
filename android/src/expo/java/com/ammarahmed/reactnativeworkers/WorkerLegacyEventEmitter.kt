package com.ammarahmed.reactnativeworkers

import android.os.Bundle
import expo.modules.core.interfaces.InternalModule
import expo.modules.core.interfaces.services.EventEmitter

/**
 * A minimal legacy `EventEmitter` service registered into the worker AppContext's
 * legacy `ModuleRegistry`.
 *
 * Why it's needed: `Module.sendEvent` routes through `appContext.eventEmitter(module)`,
 * which returns null (and so `sendEvent` silently no-ops) unless the legacy module
 * registry contains an `EventEmitter` service. A freshly-built worker AppContext
 * has an empty legacy registry, so module events never fire without this.
 *
 * Why a no-op is correct: for MODULE events, `KModuleEventEmitterWrapper.emit`
 * overrides the emit to go through the JSI path (`JNIUtils.emitEvent(jsObject,
 * runtimeContext.jsiContext, …)`) straight to the module's JS object in the WORKER
 * runtime. The legacy emitter instance is only a required gate for constructing the
 * wrapper; its `emit(...)` methods are never invoked for module events. (Legacy
 * device-event emission from a worker module has no meaningful target and is
 * unsupported — hence no-ops.)
 */
class WorkerLegacyEventEmitter : InternalModule, EventEmitter {
  override fun getExportedInterfaces(): List<Class<*>> = listOf(EventEmitter::class.java)

  override fun emit(viewId: Int, eventName: String, eventBody: Bundle?) {}

  override fun emit(eventName: String, eventBody: Bundle?) {}

  override fun emit(viewId: Int, event: EventEmitter.Event) {}
}
