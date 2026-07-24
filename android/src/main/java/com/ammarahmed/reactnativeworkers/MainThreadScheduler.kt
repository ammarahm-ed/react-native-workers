package com.ammarahmed.reactnativeworkers

import android.os.Handler
import android.os.Looper

/**
 * Main-thread (UI) dispatcher backing `UIWorker` on Android.
 *
 * A `UIWorker` runs its Hermes runtime on the platform main thread. The C++
 * `AndroidMainScheduler` (cpp/runtime/MainThreadSchedulerAndroid.cpp) drives this
 * object: it hands us each pending C++ task as an opaque pointer, we post a
 * `Runnable` onto a [Handler] bound to the main [Looper], and when that Runnable
 * runs on the main thread we call [nativeRunTask] to execute and free the task.
 *
 * The native side registers [nativeRunTask] via `RegisterNatives` the first time
 * a `UIWorker` is created (the library is linked into the app's `appmodules`
 * shared library, so it has no `JNI_OnLoad` of its own).
 */
internal object MainThreadScheduler {
  private val handler = Handler(Looper.getMainLooper())

  /** Posts a C++ task (by pointer) to run on the main thread. Called from C++. */
  @JvmStatic
  fun post(ptr: Long) {
    handler.post { nativeRunTask(ptr) }
  }

  /** Posts a C++ task to run on the main thread after [delayMs]. Called from C++. */
  @JvmStatic
  fun postDelayed(ptr: Long, delayMs: Long) {
    handler.postDelayed({ nativeRunTask(ptr) }, delayMs)
  }

  /** Whether the calling thread is the main (UI) thread. Called from C++. */
  @JvmStatic
  fun isOnMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

  /** Runs and frees a pending C++ task. Bound natively via `RegisterNatives`. */
  @JvmStatic
  external fun nativeRunTask(ptr: Long)
}
