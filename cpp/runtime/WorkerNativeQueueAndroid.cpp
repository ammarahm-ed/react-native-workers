#if defined(__ANDROID__)

#include "WorkerNativeQueue.h"

#include "WorkerThreadScope.h"

#include <fbjni/fbjni.h>

#include <android/log.h>

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
  queue->post([ref]() {
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
}

} // namespace

WorkerNativeQueue::WorkerNativeQueue() {
  thread_ = std::thread([this]() {
    // Same scoping as the worker JS thread: module bodies call JNI, and FindClass
    // must resolve app classes for the whole life of the thread.
    runInWorkerThreadScope([this]() {
      markQueueThread();
      pump();
    });
  });
  {
    std::unique_lock<std::mutex> lock(mutex_);
    // threadId_ is written by pump() before it takes any task; wait for it so
    // isCurrentThread() is meaningful the moment the constructor returns.
    cv_.wait(lock, [this] { return threadId_ != std::thread::id(); });
  }
}

WorkerNativeQueue::~WorkerNativeQueue() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) {
    // Never join from the queue itself (a module tearing down its own worker);
    // detaching leaves the loop to exit on the stop flag it has already seen.
    if (std::this_thread::get_id() == threadId_) {
      thread_.detach();
    } else {
      thread_.join();
    }
  }
}

void WorkerNativeQueue::pump() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    threadId_ = std::this_thread::get_id();
  }
  cv_.notify_all();

  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return stopped_ || !tasks_.empty(); });
      if (stopped_ && tasks_.empty()) return;
      task = std::move(tasks_.front());
      tasks_.pop_front();
    }
    try {
      task();
    } catch (const std::exception& e) {
      RNWQ_LOG("native module task threw: %s", e.what());
    } catch (...) {
      RNWQ_LOG("native module task threw (non-std)");
    }
  }
}

void WorkerNativeQueue::post(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    tasks_.push_back(std::move(task));
  }
  cv_.notify_one();
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
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) {
      tasks_.push_back([task = std::move(task), mtx, cv, done]() {
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
  cv_.notify_one();
  std::unique_lock<std::mutex> lk(*mtx);
  cv->wait(lk, [&] { return *done; });
}

bool WorkerNativeQueue::isCurrentThread() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return std::this_thread::get_id() == threadId_;
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
