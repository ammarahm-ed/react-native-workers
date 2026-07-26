#include "ThreadTarget.h"

#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

#include "MainThreadScheduler.h"
#include "WorkerThreadScope.h"

namespace facebook::react::workers {

namespace {

// Set for the duration of a task so `Thread.current` can name the thread the
// caller is on. Thread-local, not lock-guarded: it describes the OS thread, not
// the runtime.
std::string& currentName() {
  static thread_local std::string name;
  return name;
}

class ScopedCurrentName {
 public:
  explicit ScopedCurrentName(const std::string& name)
      : previous_(currentName()) {
    currentName() = name;
  }
  ~ScopedCurrentName() {
    currentName() = previous_;
  }

 private:
  std::string previous_;
};

// The platform main thread, as a ThreadTarget. Delegates to the same
// MainThreadScheduler that UIWorker runs on, so main-thread work from a worker
// and a UIWorker's own loop share one queue and cannot interleave mid-task.
class MainThreadTarget : public ThreadTarget {
 public:
  explicit MainThreadTarget(std::shared_ptr<MainThreadScheduler> scheduler)
      : ThreadTarget("main"), scheduler_(std::move(scheduler)) {}

  void post(std::function<void()> fn) override {
    scheduler_->post([fn = std::move(fn)]() {
      ScopedCurrentName current("main");
      fn();
    });
  }

  bool isCurrent() const override {
    return scheduler_->isOnMainThread();
  }

 private:
  std::shared_ptr<MainThreadScheduler> scheduler_;
};

// A plain serial worker thread. Pure C++ on purpose: unlike the main thread,
// a background target needs no platform run loop, so iOS and Android share one
// implementation. The body runs inside runInWorkerThreadScope so JNI FindClass
// from this thread resolves app classes on Android (see WorkerThreadScope.h) —
// worker JS running here can reach native modules just like it can at home.
class SerialThreadTarget : public ThreadTarget {
 public:
  // The queue lives in a shared block, not in the target, because a target can
  // legitimately be disposed BY a task running on its own thread. That thread
  // then keeps the block alive until its loop unwinds, long after the
  // SerialThreadTarget object is gone.
  struct State {
    std::mutex mutex;
    std::condition_variable cv;
    std::deque<std::function<void()>> tasks;
    bool stop = false;
    std::thread::id threadId;
  };

  explicit SerialThreadTarget(std::string name)
      : ThreadTarget(std::move(name)), state_(std::make_shared<State>()) {
    auto state = state_;
    std::string threadName = this->name();
    thread_ = std::thread([state, threadName]() {
      runInWorkerThreadScope([&]() { loop(state, threadName); });
    });
    // Recorded from the thread OBJECT, not from inside the thread body: the body
    // would race every isCurrent() call until it got scheduled.
    state_->threadId = thread_.get_id();
  }

  ~SerialThreadTarget() override {
    {
      std::lock_guard<std::mutex> lock(state_->mutex);
      state_->stop = true;
      state_->tasks.clear();
    }
    state_->cv.notify_one();
    // Detach, never join. A worker disposes its targets while holding the
    // runtime lock, and a target thread parked in WorkerJsScope waiting for that
    // same lock could never reach the stop flag — join would deadlock. The
    // thread co-owns `state_`, so letting it unwind on its own is safe: it wakes
    // when the lock is released, finds the runtime unpublished, and exits.
    // Queued closures hold no jsi references (see ThreadTarget::post), so
    // clearing them here without the runtime lock is safe too.
    if (thread_.joinable()) {
      thread_.detach();
    }
  }

  void post(std::function<void()> fn) override {
    {
      std::lock_guard<std::mutex> lock(state_->mutex);
      if (state_->stop) return;
      state_->tasks.push_back(std::move(fn));
    }
    state_->cv.notify_one();
  }

  bool isCurrent() const override {
    return std::this_thread::get_id() == state_->threadId;
  }

 private:
  static void loop(
      const std::shared_ptr<State>& state,
      const std::string& threadName) {
    ScopedCurrentName current(threadName);
    for (;;) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lock(state->mutex);
        state->cv.wait(
            lock, [&] { return state->stop || !state->tasks.empty(); });
        if (state->stop) return;
        task = std::move(state->tasks.front());
        state->tasks.pop_front();
      }
      // A task is worker JS under the runtime lock; runGuarded at the JS entry
      // point already reports its errors, so anything escaping here is a bug in
      // the binding rather than in user code. Swallow it: killing this thread
      // would strand every later post() on it.
      try {
        task();
      } catch (...) {
      }
      // Safe to destroy here with no runtime lock held: posted closures carry no
      // jsi references (see ThreadTarget::post).
      task = nullptr;
    }
  }

  std::shared_ptr<State> state_;
  std::thread thread_;
};

} // namespace

std::shared_ptr<ThreadTarget> mainThreadTarget() {
  static std::mutex m;
  static std::shared_ptr<ThreadTarget> target;
  std::lock_guard<std::mutex> lock(m);
  if (!target) {
    auto scheduler = getMainThreadScheduler();
    if (!scheduler) return nullptr;
    target = std::make_shared<MainThreadTarget>(std::move(scheduler));
  }
  return target;
}

std::shared_ptr<ThreadTarget> makeSerialThreadTarget(std::string name) {
  return std::make_shared<SerialThreadTarget>(std::move(name));
}

const std::string& currentThreadTargetName() {
  return currentName();
}

} // namespace facebook::react::workers
