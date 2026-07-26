// Android implementation of HostThreadWaker: wakes the host JS thread with an
// eventfd on its native looper, so a worker->host delivery never enters Java.
//
// See HostThreadWaker.h for why. In short, the CallInvoker path costs a JVM
// attach, a Java object allocation and a Java MessageQueue post per message,
// purely to hand a C++ payload from one C++ thread to another. Here the worker
// thread's entire cost is one `write()` syscall.
#if defined(__ANDROID__)

#include "HostThreadWaker.h"

#include <android/log.h>
#include <android/looper.h>
#include <fbjni/fbjni.h>
#include <sys/eventfd.h>
#include <unistd.h>

#include <mutex>
#include <utility>
#include <vector>

namespace facebook::react::workers {

namespace {

#define RNWW_LOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerWake", __VA_ARGS__)

class AndroidHostThreadWaker : public HostThreadWaker {
 public:
  // Must be constructed on the host JS thread: ALooper_forThread() is
  // thread-local, and `runtime` is the runtime of the calling thread.
  static std::shared_ptr<AndroidHostThreadWaker> create(jsi::Runtime& runtime) {
    ALooper* looper = ALooper_forThread();
    if (looper == nullptr) {
      // No native looper on this thread (not a Looper-backed thread). Caller
      // falls back to the CallInvoker.
      RNWW_LOG("no native looper on the host JS thread; using CallInvoker");
      return nullptr;
    }

    // EFD_NONBLOCK so the drain read() never blocks the JS thread if the
    // counter was already consumed; EFD_CLOEXEC so it does not leak into forks.
    int fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (fd < 0) {
      RNWW_LOG("eventfd() failed; using CallInvoker");
      return nullptr;
    }

    ALooper_acquire(looper);
    auto waker = std::shared_ptr<AndroidHostThreadWaker>(
        new AndroidHostThreadWaker(runtime, looper, fd));

    // ALOOPER_POLL_CALLBACK: the ident is ignored when a callback is supplied.
    // `waker.get()` is a raw back-pointer; the destructor removes the fd from
    // the looper (on this same thread) before it becomes dangling.
    if (ALooper_addFd(
            looper,
            fd,
            ALOOPER_POLL_CALLBACK,
            ALOOPER_EVENT_INPUT,
            &AndroidHostThreadWaker::onWake,
            waker.get()) != 1) {
      RNWW_LOG("ALooper_addFd() failed; using CallInvoker");
      return nullptr; // destructor cleans up fd + looper ref
    }

    RNWW_LOG("installed native host wakeup (eventfd=%d) — worker->host "
             "deliveries now bypass the JVM",
             fd);
    return waker;
  }

  ~AndroidHostThreadWaker() override {
    // Remove first. Called on the looper's own thread, so this guarantees the
    // callback is not running and will not run again — only then is it safe to
    // drop the `this` the looper holds.
    if (fd_ >= 0) {
      ALooper_removeFd(looper_, fd_);
      close(fd_);
    }
    if (looper_ != nullptr) {
      ALooper_release(looper_);
    }
  }

  void post(std::function<void(jsi::Runtime&)> task) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending_.push_back(std::move(task));
    }
    // One 8-byte write is the whole cross-thread cost. The counter semantics of
    // an eventfd coalesce naturally: many writes before the host drains produce
    // a single wakeup that runs every queued task.
    const uint64_t one = 1;
    ssize_t written = ::write(fd_, &one, sizeof(one));
    (void)written; // EAGAIN only when the counter is saturated, which still wakes
  }

 private:
  AndroidHostThreadWaker(jsi::Runtime& runtime, ALooper* looper, int fd)
      : runtime_(&runtime), looper_(looper), fd_(fd) {}

  // Runs ON the host JS thread, from inside the looper's poll.
  static int onWake(int fd, int /*events*/, void* data) {
    uint64_t count = 0;
    // Clear the counter so the fd stops signalling. NONBLOCK, so a spurious
    // wake with nothing to read is harmless.
    ssize_t got = ::read(fd, &count, sizeof(count));
    (void)got;

    auto* self = static_cast<AndroidHostThreadWaker*>(data);
    self->drain();
    return 1; // keep the fd registered
  }

  void drain() {
    std::vector<std::function<void(jsi::Runtime&)>> batch;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      batch.swap(pending_);
    }
    if (batch.empty()) return;

    // Run the batch under the app class loader.
    //
    // We reach here from ALooper's poll callback inside
    // MessageQueue.nativePollOnce, so although the host JS thread IS a Java
    // thread, there is no app Java frame on the stack — a JNI FindClass
    // performed by the JS we are about to run (any TurboModule call that
    // resolves an app class) would use the boot class loader and fail with
    // NoClassDefFoundError. ART then aborts the process at the next JNI call.
    // Bypassing the JVM for the wakeup is the whole point of this class, but
    // the JS it triggers still needs a class loader. Same fix, same reason, as
    // MainThreadSchedulerAndroid::runTask.
    try {
      facebook::jni::ThreadScope::WithClassLoader([&]() { runBatch(batch); });
    } catch (const std::exception& e) {
      // No JVM / no class loader available: still run the work rather than drop
      // it. JS that touches no app class is unaffected.
      RNWW_LOG("WithClassLoader failed (%s); running without it", e.what());
      runBatch(batch);
    }
  }

  void runBatch(std::vector<std::function<void(jsi::Runtime&)>>& batch) {
    for (auto& task : batch) {
      try {
        task(*runtime_);
      } catch (const std::exception& e) {
        // An exception must never escape into the looper — it would tear down
        // the host thread's message loop, not just this delivery.
        RNWW_LOG("host task threw: %s", e.what());
      } catch (...) {
        RNWW_LOG("host task threw a non-std exception");
      }
    }

    // RuntimeScheduler normally drains microtasks after running JS. We are
    // deliberately outside it, so promise continuations queued by the tasks
    // above would otherwise sit until some unrelated work ran. Drain here.
    try {
      runtime_->drainMicrotasks();
    } catch (...) {
      RNWW_LOG("drainMicrotasks threw");
    }
  }

  jsi::Runtime* runtime_;
  ALooper* looper_ = nullptr;
  int fd_ = -1;

  std::mutex mutex_;
  std::vector<std::function<void(jsi::Runtime&)>> pending_;
};

} // namespace

std::shared_ptr<HostThreadWaker> createHostThreadWaker(jsi::Runtime& runtime) {
  return AndroidHostThreadWaker::create(runtime);
}

} // namespace facebook::react::workers

#endif // __ANDROID__
