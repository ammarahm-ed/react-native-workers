package com.ammarahmed.reactnativeworkers

/**
 * Kotlin face of a worker's native-modules queue (cpp/runtime/WorkerNativeQueue.h).
 *
 * The queue itself is a C++ thread, one per worker, on which that worker's Java
 * module method bodies run — so a blocking module stalls only its own queue, never
 * the worker's JS thread and never the host.
 *
 * This object exists so [WorkerReactContext] can answer RN's queue questions about
 * that thread. Modules routinely call `assertOnNativeModulesQueueThread()` or hand
 * work to `runOnNativeModulesQueueThread(...)`; answered from the host context
 * those would assert against — and dispatch onto — the *host's* native queue,
 * which is both wrong and a shared-thread dependency.
 *
 * [markCurrentThread] is called once from C++ when a queue thread starts. A
 * dedicated thread never stops being one, so the thread-local flag needs no
 * per-task bookkeeping; the flag makes the common "am I on a worker queue?" check
 * free, and [nativeIsOnQueue] answers precisely *which* worker's queue it is.
 */
internal object WorkerNativeQueue {

  private val isQueueThread = ThreadLocal.withInitial { false }

  /** Called from C++ on each queue thread at startup. */
  @JvmStatic
  fun markCurrentThread() {
    isQueueThread.set(true)
  }

  /** Whether the calling thread is some worker's native queue thread. */
  @JvmStatic
  fun isOnAnyQueueThread(): Boolean = isQueueThread.get() == true

  /** Whether the calling thread is the queue thread for [queueId] specifically. */
  @JvmStatic
  fun isOnQueue(queueId: Long): Boolean =
    queueId != 0L && isOnAnyQueueThread() && nativeIsOnQueue(queueId)

  /** Runs [runnable] on [queueId]'s thread. A stale id drops the work. */
  @JvmStatic
  fun post(queueId: Long, runnable: Runnable) {
    if (queueId == 0L) return
    nativePostRunnable(queueId, runnable)
  }

  @JvmStatic private external fun nativeIsOnQueue(queueId: Long): Boolean

  @JvmStatic private external fun nativePostRunnable(queueId: Long, runnable: Runnable)
}
