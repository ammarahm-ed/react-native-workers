#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <functional>
#include <memory>

namespace facebook::react::workers {

// Runs a task on the host JS thread WITHOUT going through Java.
//
// Why this exists
// ---------------
// Worker->worker delivery is already pure C++: a nested worker resolves its own
// ReactNativeWorkersImpl bound to the worker's InertInvoker, which is a mutex +
// condition_variable on our own thread. Nothing touches the JVM.
//
// Worker->HOST delivery is the exception, because the host JS thread is a Java
// Looper thread. `CallInvoker::invokeAsync` bottoms out in
// JMessageQueueThread::runOnQueue, which per message does:
//
//   jni::ThreadScope guard;                        // attach worker thread to JVM
//   JNativeRunnable::newObjectCxxArgs(...)         // Java object allocation
//   method(m_jobj, jrunnable.get());               // post to Java MessageQueue
//                                                  // ...then JNI back into C++
//
// That is a JVM round trip purely to move a C++ payload between two C++ threads.
//
// How it is avoided
// -----------------
// An `android.os.Looper` is backed by a native `Looper`, and `ALooper_forThread()`
// returns it. So we register an eventfd on the host thread's looper with a NATIVE
// callback. Waking the host is then a single `write()` syscall from the worker
// thread; the callback runs in C++ with no JVM attach, no Java allocation, and no
// Java frame.
//
// Tradeoff, deliberately accepted: the callback runs from inside the looper's
// poll rather than from a dispatched Message, so this work is not sequenced by
// RuntimeScheduler and can run ahead of pending React work.
//
// Platforms without an implementation (iOS, where the hop is already cheap)
// return nullptr from create() and callers fall back to the CallInvoker.
class HostThreadWaker {
 public:
  virtual ~HostThreadWaker() = default;

  // Queues `task` and wakes the host JS thread. Callable from any thread.
  // `task` runs on the host JS thread with the host runtime.
  virtual void post(std::function<void(jsi::Runtime&)> task) = 0;
};

// Builds a waker for the host JS thread, or nullptr when unavailable (no
// platform implementation, or the host thread has no native looper).
//
// MUST be called on the host JS thread — the looper is obtained from the
// CALLING thread, and `runtime` is captured for the waker's lifetime.
std::shared_ptr<HostThreadWaker> createHostThreadWaker(jsi::Runtime& runtime);

} // namespace facebook::react::workers
