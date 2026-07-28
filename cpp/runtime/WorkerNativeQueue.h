#pragma once

#if defined(__ANDROID__)

#include <ReactCommon/TurboModule.h>

#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

namespace facebook::react::workers {

// A worker's native-modules queue: one dedicated thread per worker on which its
// Java module method bodies run.
//
// Without it, module bodies ran inline on the worker's JS thread, so any module
// doing blocking work (a synchronous file read, a lock, a slow JNI call) stalled
// that worker's event loop — the same starvation shape we removed from the host,
// just relocated onto the worker. RN itself never does this: on the host, module
// methods run on the NativeModules queue, not the JS thread.
//
// The thread is JVM-attached with the app class loader for its whole life (module
// bodies call JNI, and FindClass must resolve app classes), mirroring how the
// worker JS thread is scoped.
class WorkerNativeQueue {
 public:
  WorkerNativeQueue();
  ~WorkerNativeQueue();

  WorkerNativeQueue(const WorkerNativeQueue&) = delete;
  WorkerNativeQueue& operator=(const WorkerNativeQueue&) = delete;

  // Returns false when the queue is stopped and the task was NOT taken, so a
  // caller holding a resource for it (a JNI global ref) can release it.
  bool post(std::function<void()> task);
  // Runs `task` on the queue and waits. Inline when already on the queue thread,
  // so a module calling back into itself cannot deadlock against its own queue.
  void runSync(std::function<void()> task);
  bool isCurrentThread() const;
  // False when the thread never started; callers should not dispatch to it.
  bool isUsable() const;

 private:
  // Everything the pump thread touches lives here, behind a shared_ptr the thread
  // owns a reference to.
  //
  // The queue object itself can die ON the queue thread: a module invalidated
  // during teardown drops the last reference from inside a task it is running.
  // The destructor detaches in that case (it cannot join itself), but with the
  // state inlined the pump loop then returned into a destroyed mutex — a
  // use-after-free the detach was supposed to avoid. Sharing the state means the
  // loop always has something valid to finish on.
  struct State {
    std::mutex mutex;
    std::condition_variable cv;
    std::deque<std::function<void()>> tasks;
    bool stopped = false;
    std::thread::id threadId;
  };

  static void pump(const std::shared_ptr<State>& state);

  std::shared_ptr<State> state_;
  std::thread thread_;
};

// A NativeMethodCallInvoker backed by a WorkerNativeQueue. Handed to the worker's
// TurboModuleManager, so every Java module method it dispatches lands on the
// worker's own native thread.
class WorkerNativeMethodCallInvoker : public NativeMethodCallInvoker {
 public:
  explicit WorkerNativeMethodCallInvoker(std::shared_ptr<WorkerNativeQueue> queue)
      : queue_(std::move(queue)) {}

  void invokeAsync(const std::string& methodName, NativeMethodCallFunc&& func) noexcept
      override;
  void invokeSync(const std::string& methodName, NativeMethodCallFunc&& func) override;

 private:
  std::shared_ptr<WorkerNativeQueue> queue_;
};

// Registry so the Kotlin side can reach a worker's queue by opaque id — used by
// WorkerReactContext to answer `isOnNativeModulesQueueThread()` truthfully and to
// serve `runOnNativeModulesQueueThread()` from the worker's own queue rather than
// the host's. Erased on teardown; a call with a stale id is a no-op.
long long registerWorkerNativeQueue(std::shared_ptr<WorkerNativeQueue> queue);
void unregisterWorkerNativeQueue(long long queueId);
std::shared_ptr<WorkerNativeQueue> lookupWorkerNativeQueue(long long queueId);

// Remembers which queue belongs to which worker runtime, so a LATER installer on
// the same worker (the Expo AppContext, installed after TurboModules in
// Worker.cpp) can answer queue questions about the same thread instead of
// falling back to the host's.
void setWorkerNativeQueueIdForRuntime(void* runtime, long long queueId);
long long workerNativeQueueIdForRuntime(void* runtime);
void clearWorkerNativeQueueIdForRuntime(void* runtime);

// Binds the Kotlin WorkerNativeQueue natives. Call on a JNI-attached thread with
// the app class loader in scope. Idempotent; returns false if binding failed.
bool ensureWorkerNativeQueueRegistered();

} // namespace facebook::react::workers

#endif // __ANDROID__
