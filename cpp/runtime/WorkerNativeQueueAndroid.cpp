#if defined(__ANDROID__)

#include "WorkerNativeQueue.h"

#include "WorkerThreadScope.h"

#include <fbjni/fbjni.h>

#include <android/log.h>

#include <chrono>
#include <unordered_map>
#include <utility>

#define RNWQ_LOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerQueue", __VA_ARGS__)

namespace facebook::react::workers {

namespace {

constexpr const char* kQueueClass =
    "com/ammarahmed/reactnativeworkers/WorkerNativeQueue";

std::mutex& queueMutex() {
  static std::mutex m;
  return m;
}
std::unordered_map<long long, std::weak_ptr<WorkerNativeQueue>>& queueRegistry() {
  static std::unordered_map<long long, std::weak_ptr<WorkerNativeQueue>> r;
  return r;
}

// Marks the calling thread as a worker native queue thread, once, on the Kotlin
// side. A dedicated thread never stops being one, so a thread-local flag set at
// startup is enough and costs nothing per task.
void markQueueThread() {
  try {
    auto cls = facebook::jni::findClassStatic(kQueueClass);
    JNIEnv* env = facebook::jni::Environment::current();
    jmethodID mark = env->GetStaticMethodID(cls.get(), "markCurrentThread", "()V");
    if (mark) {
      env->CallStaticVoidMethod(cls.get(), mark);
    }
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
    }
  } catch (const std::exception& e) {
    RNWQ_LOG("could not mark queue thread: %s", e.what());
  }
}

// --- Kotlin-facing natives ---------------------------------------------------

jboolean isOnQueueNative(JNIEnv*, jclass, jlong queueId) {
  auto queue = lookupWorkerNativeQueue(static_cast<long long>(queueId));
  return (queue && queue->isCurrentThread()) ? JNI_TRUE : JNI_FALSE;
}

// Posts a Java Runnable onto the worker's native queue. Takes a global ref for the
// hop and releases it after the run (on the queue thread, which is attached).
void postRunnableNative(JNIEnv* env, jclass, jlong queueId, jobject runnable) {
  auto queue = lookupWorkerNativeQueue(static_cast<long long>(queueId));
  if (!queue || !runnable) return;
  jobject ref = env->NewGlobalRef(runnable);
  // The ref must be released even when the queue refuses the task (torn down),
  // otherwise every post after shutdown leaks a global ref.
  bool accepted = queue->post([ref]() {
    JNIEnv* env = facebook::jni::Environment::current();
    jclass cls = env->GetObjectClass(ref);
    jmethodID run = env->GetMethodID(cls, "run", "()V");
    if (run) {
      env->CallVoidMethod(ref, run);
    }
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
    }
    env->DeleteLocalRef(cls);
    env->DeleteGlobalRef(ref);
  });
  if (!accepted) {
    env->DeleteGlobalRef(ref);
  }
}

} // namespace

WorkerNativeQueue::WorkerNativeQueue() : state_(std::make_shared<State>()) {
  // The thread owns a reference to the state, so it can finish its loop even if
  // the queue object is destroyed from inside one of its own tasks (see State).
  thread_ = std::thread([state = state_]() {
    // Same scoping as the worker JS thread: module bodies call JNI, and FindClass
    // must resolve app classes for the whole life of the thread.
    runInWorkerThreadScope([&state]() {
      markQueueThread();
      pump(state);
    });
  });
  {
    std::unique_lock<std::mutex> lock(state_->mutex);
    // threadId is written by pump() before it takes any task; wait for it so
    // isCurrentThread() is meaningful the moment the constructor returns.
    //
    // BOUNDED: if the thread body never runs (a JVM attach failure inside the
    // thread scope), an unconditional wait would block the worker's JS thread
    // forever inside installWorkerTurboModules, with nothing logged. Time out and
    // let the caller fall back instead.
    if (!state_->cv.wait_for(lock, std::chrono::seconds(5), [this] {
          return state_->threadId != std::thread::id();
        })) {
      RNWQ_LOG("queue thread failed to start within 5s — this worker will fall "
               "back to running module bodies inline");
      state_->stopped = true;
    }
  }
}

WorkerNativeQueue::~WorkerNativeQueue() {
  bool onQueueThread;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    state_->stopped = true;
    onQueueThread = std::this_thread::get_id() == state_->threadId;
  }
  state_->cv.notify_all();
  if (thread_.joinable()) {
    // Never join from the queue itself (a module tearing down its own worker);
    // detaching leaves the loop to exit on the stop flag it has already seen —
    // safely, because the loop reads the shared state, not this object.
    if (onQueueThread) {
      thread_.detach();
    } else {
      thread_.join();
    }
  }
}

void WorkerNativeQueue::pump(const std::shared_ptr<State>& state) {
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->threadId = std::this_thread::get_id();
  }
  state->cv.notify_all();

  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(state->mutex);
      state->cv.wait(lock, [&] { return state->stopped || !state->tasks.empty(); });
      if (state->stopped && state->tasks.empty()) return;
      task = std::move(state->tasks.front());
      state->tasks.pop_front();
    }
    try {
      task();
    } catch (const std::exception& e) {
      RNWQ_LOG("native module task threw: %s", e.what());
    } catch (...) {
      RNWQ_LOG("native module task threw (non-std)");
    }
    // Dropped OUTSIDE the lock and before waiting again: a task's captures can
    // own the last reference to this queue, and running ~WorkerNativeQueue while
    // holding its own mutex would deadlock on the destructor's lock.
    task = nullptr;
  }
}

bool WorkerNativeQueue::post(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->stopped) return false;
    state_->tasks.push_back(std::move(task));
  }
  state_->cv.notify_one();
  return true;
}

void WorkerNativeQueue::runSync(std::function<void()> task) {
  if (isCurrentThread()) {
    task();
    return;
  }
  auto mtx = std::make_shared<std::mutex>();
  auto cv = std::make_shared<std::condition_variable>();
  auto done = std::make_shared<bool>(false);
  bool queued = false;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (!state_->stopped) {
      state_->tasks.push_back([task = std::move(task), mtx, cv, done]() {
        task();
        {
          std::lock_guard<std::mutex> lk(*mtx);
          *done = true;
        }
        cv->notify_all();
      });
      queued = true;
    }
  }
  if (!queued) return; // torn down: a sync call has nowhere to run
  state_->cv.notify_one();
  std::unique_lock<std::mutex> lk(*mtx);
  cv->wait(lk, [&] { return *done; });
}

bool WorkerNativeQueue::isUsable() const {
  std::lock_guard<std::mutex> lock(state_->mutex);
  return !state_->stopped && state_->threadId != std::thread::id();
}

bool WorkerNativeQueue::isCurrentThread() const {
  std::lock_guard<std::mutex> lock(state_->mutex);
  return std::this_thread::get_id() == state_->threadId;
}

void WorkerNativeMethodCallInvoker::invokeAsync(
    const std::string& /*methodName*/,
    NativeMethodCallFunc&& func) noexcept {
  queue_->post(std::move(func));
}

void WorkerNativeMethodCallInvoker::invokeSync(
    const std::string& /*methodName*/,
    NativeMethodCallFunc&& func) {
  queue_->runSync(std::move(func));
}

namespace {
std::mutex& runtimeQueueMutex() {
  static std::mutex m;
  return m;
}
std::unordered_map<void*, long long>& runtimeQueueIds() {
  static std::unordered_map<void*, long long> r;
  return r;
}
} // namespace

void setWorkerNativeQueueIdForRuntime(void* runtime, long long queueId) {
  if (!runtime) return;
  std::lock_guard<std::mutex> lock(runtimeQueueMutex());
  if (queueId == 0) {
    runtimeQueueIds().erase(runtime);
  } else {
    runtimeQueueIds()[runtime] = queueId;
  }
}

long long workerNativeQueueIdForRuntime(void* runtime) {
  if (!runtime) return 0;
  std::lock_guard<std::mutex> lock(runtimeQueueMutex());
  auto& r = runtimeQueueIds();
  auto it = r.find(runtime);
  return it == r.end() ? 0 : it->second;
}

void clearWorkerNativeQueueIdForRuntime(void* runtime) {
  setWorkerNativeQueueIdForRuntime(runtime, 0);
}

long long registerWorkerNativeQueue(std::shared_ptr<WorkerNativeQueue> queue) {
  if (!ensureWorkerNativeQueueRegistered()) return 0;
  static long long nextId = 1;
  std::lock_guard<std::mutex> lock(queueMutex());
  long long id = nextId++;
  queueRegistry()[id] = queue;
  return id;
}

void unregisterWorkerNativeQueue(long long queueId) {
  if (queueId == 0) return;
  std::lock_guard<std::mutex> lock(queueMutex());
  queueRegistry().erase(queueId);
}

std::shared_ptr<WorkerNativeQueue> lookupWorkerNativeQueue(long long queueId) {
  if (queueId == 0) return nullptr;
  std::lock_guard<std::mutex> lock(queueMutex());
  auto& r = queueRegistry();
  auto it = r.find(queueId);
  if (it == r.end()) return nullptr;
  return it->second.lock();
}

bool ensureWorkerNativeQueueRegistered() {
  static bool ok = false;
  static std::once_flag once;
  std::call_once(once, [] {
    try {
      auto cls = facebook::jni::findClassStatic(kQueueClass);
      JNIEnv* env = facebook::jni::Environment::current();
      static const JNINativeMethod methods[] = {
          {"nativeIsOnQueue", "(J)Z", reinterpret_cast<void*>(&isOnQueueNative)},
          {"nativePostRunnable",
           "(JLjava/lang/Runnable;)V",
           reinterpret_cast<void*>(&postRunnableNative)},
      };
      if (env->RegisterNatives(cls.get(), methods, 2) != JNI_OK) {
        if (env->ExceptionCheck()) {
          env->ExceptionDescribe();
          env->ExceptionClear();
        }
        RNWQ_LOG("RegisterNatives failed for WorkerNativeQueue");
        return;
      }
      ok = true;
    } catch (const std::exception& e) {
      RNWQ_LOG("WorkerNativeQueue registration failed: %s", e.what());
    }
  });
  return ok;
}

} // namespace facebook::react::workers

#endif // __ANDROID__
