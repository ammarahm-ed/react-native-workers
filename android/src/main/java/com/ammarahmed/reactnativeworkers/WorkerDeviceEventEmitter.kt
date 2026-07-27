package com.ammarahmed.reactnativeworkers

import android.os.Bundle
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeArray
import java.lang.reflect.Proxy
import java.util.concurrent.ConcurrentHashMap

/**
 * A device-event emitter bound to ONE worker runtime.
 *
 * This is the Android half of the isolation rule that native module events raised
 * by a worker's modules must never touch the host runtime or the RN JS thread.
 *
 * The default path does exactly that: RN modules emit through
 * `ReactContext.emitDeviceEvent`, which resolves
 * `getJSModule(RCTDeviceEventEmitter::class.java)`. [WorkerReactContext] delegates
 * almost everything to the host context, so without this class the event would be
 * dispatched on the HOST runtime, then copied back out to interested workers — a
 * JS-thread round trip plus a structured-clone copy for every event, including
 * every chunk of an HTTP response (`NetworkEventUtil` emits this way).
 *
 * [WorkerReactContext] therefore serves this emitter instead, and the event is
 * marshalled straight into the worker's own `global.__rctDeviceEventEmitter` on the
 * worker thread. The host runtime is never involved and nothing is copied through
 * it.
 *
 * ## Why a reflective Proxy rather than `: RCTDeviceEventEmitter`
 *
 * There is more than one interface by that name and RN changes which one it asks
 * for: 0.81–0.85 resolve `DeviceEventManagerModule.RCTDeviceEventEmitter`, while
 * 0.86 asks for `ReactContext.RCTDeviceEventEmitter` — a distinct type that does
 * not exist on the older versions. Implementing either one statically fails
 * `isInstance` on the versions that ask for the other (silently: the event just
 * goes to the host), and implementing both fails to compile where one is absent.
 *
 * So we implement none of them and build a [Proxy] for whichever interface the
 * caller asks for, matched by simple name. Same tolerance idea as the reflective
 * Expo installer — never hard-fail on a renamed internal.
 *
 * `sinkId` identifies a C++ side record holding this worker's `CallInvoker`
 * (registered in WorkerTurboModulesAndroid.cpp before the context is built, and
 * erased when the worker tears down). Emitting against a torn-down worker looks up
 * a missing sink and is a silent no-op, which is what we want: modules can and do
 * emit from their own threads (OkHttp, executors) after a worker is gone.
 */
internal class WorkerDeviceEventEmitter(private val sinkId: Long) {

  private val proxies = ConcurrentHashMap<Class<*>, Any>()

  /** Whether this emitter should serve [jsInterface] instead of the host. */
  fun serves(jsInterface: Class<*>): Boolean =
    jsInterface.simpleName in EMITTER_INTERFACES

  /**
   * A [jsInterface] implementation whose `emit` reaches this worker. Cached per
   * interface — RN resolves the emitter on every event.
   */
  fun proxyFor(jsInterface: Class<*>): Any =
    proxies.getOrPut(jsInterface) {
      Proxy.newProxyInstance(
        jsInterface.classLoader,
        arrayOf(jsInterface),
      ) { _, method, args ->
        when {
          method.name == "emit" && args != null && args.isNotEmpty() ->
            emit(args[0] as String, args.getOrNull(1))
          // Object methods still have to behave (logging, collections).
          method.name == "toString" -> "WorkerDeviceEventEmitter(sink=$sinkId)"
          method.name == "hashCode" -> sinkId.hashCode()
          method.name == "equals" -> args?.getOrNull(0) === this
          else -> null
        }
      }
    }

  private fun emit(eventName: String, data: Any?) {
    if (sinkId == 0L) return
    // Marshal to a NativeArray so C++ can take the payload as a folly::dynamic in
    // one hop. Built fresh per emit, so consuming it on the native side is safe.
    val args = WritableNativeArray()
    when (data) {
      null -> args.pushNull()
      is ReadableMap -> args.pushMap(data)
      is ReadableArray -> args.pushArray(data)
      is String -> args.pushString(data)
      is Boolean -> args.pushBoolean(data)
      is Number -> args.pushDouble(data.toDouble())
      is Bundle -> args.pushMap(Arguments.fromBundle(data))
      else -> args.pushString(data.toString())
    }
    nativeEmit(sinkId, eventName, args)
  }

  companion object {
    /**
     * Simple names of the JS-module interfaces a worker serves itself. Matched by
     * simple name because the package differs across RN versions (see above).
     */
    private val EMITTER_INTERFACES =
      setOf("RCTDeviceEventEmitter", "RCTNativeAppEventEmitter")

    /**
     * Hands the payload to the worker's CallInvoker. Bound via `RegisterNatives`
     * from C++ when the worker's TurboModule manager is built (the library is
     * linked into the app's `appmodules` shared library, so it has no
     * `JNI_OnLoad` of its own) — same idiom as [MainThreadScheduler].
     *
     * Callable from any thread: the native side only touches JNI on the calling
     * thread and posts the JSI work onto the worker thread.
     */
    @JvmStatic
    external fun nativeEmit(sinkId: Long, eventName: String, args: WritableNativeArray)
  }
}
