#include "HermesWorkerHost.h"

#include <hermes/Public/GCConfig.h>
#include <hermes/Public/RuntimeConfig.h>
#include <hermes/hermes.h>
#include <jsi/instrumentation.h>

#include <utility>

#include "WorkerInspector.h"
#include "WorkerThreadScope.h"

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

void reportUncaughtToJs(Runtime& rt, const Value& errorValue) {
  try {
    Function report =
        rt.global().getPropertyAsFunction(rt, "__rnworkersReportError");
    report.call(rt, Value(rt, errorValue));
  } catch (...) {
    // If error reporting itself fails, there's nothing more we can do.
  }
}

void runGuarded(Runtime& rt, const std::function<void()>& fn) {
  try {
    fn();
  } catch (const JSError& e) {
    reportUncaughtToJs(rt, e.value());
  } catch (const std::exception& e) {
    Value msg(String::createFromUtf8(rt, e.what()));
    reportUncaughtToJs(rt, msg);
  }
}


// A short, human-readable identity for the debugger target list. Named workers
// use their name; unnamed ones fall back to the bundle's file stem, because the
// raw dev source URL is a full Metro URL with a query string, and several of
// those side by side are unreadable.
std::string workerDisplayName(
    const std::string& name,
    const std::string& sourceUrl) {
  if (!name.empty()) return name;
  if (sourceUrl.empty()) return "anonymous";
  std::string s = sourceUrl;
  auto q = s.find('?');
  if (q != std::string::npos) s = s.substr(0, q);
  auto slash = s.find_last_of('/');
  if (slash != std::string::npos) s = s.substr(slash + 1);
  auto dot = s.find('.');
  if (dot != std::string::npos && dot > 0) s = s.substr(0, dot);
  return s.empty() ? "anonymous" : s;
}

} // namespace

// A CallInvoker that posts onto the worker thread and goes inert once the host
// is torn down (so native module callbacks firing after terminate() are dropped
// instead of touching a dead runtime). Phase 3 relies on this.
class HermesWorkerHost::InertInvoker : public CallInvoker {
 public:
  explicit InertInvoker(std::shared_ptr<InvokerShared> shared)
      : shared_(std::move(shared)) {}

  void invokeAsync(CallFunc&& func) noexcept override {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    if (shared_->host) {
      shared_->host->post(std::move(func));
    }
  }
  void invokeSync(CallFunc&& /*func*/) override {
    // Synchronous cross-thread calls into a worker are not supported.
    throw std::runtime_error("invokeSync is not supported for workers");
  }

 private:
  std::shared_ptr<InvokerShared> shared_;
};

HermesWorkerHost::HermesWorkerHost(std::string name, uint32_t maxHeapMb)
    : name_(std::move(name)),
      maxHeapMb_(maxHeapMb ? maxHeapMb : 256),
      // Created eagerly so callInvoker() is safe from any thread (a lazy init
      // there would race two first callers).
      invokerShared_(std::make_shared<InvokerShared>()) {
  invokerShared_->host = this;
}

HermesWorkerHost::~HermesWorkerHost() {
  requestShutdown(/*immediate=*/true);
  {
    std::lock_guard<std::mutex> lock(invokerShared_->mutex);
    invokerShared_->host = nullptr;
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

void HermesWorkerHost::start(
    std::string prelude,
    std::string code,
    std::string sourceUrl,
    InstallFn install) {
  thread_ = std::thread(
      &HermesWorkerHost::threadMain,
      this,
      std::move(prelude),
      std::move(code),
      std::move(sourceUrl),
      std::move(install));
}

void HermesWorkerHost::post(Task&& task) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stop_) return;
    tasks_.push_back(std::move(task));
  }
  // Exactly one waiter (the worker thread).
  cv_.notify_one();
}

std::shared_ptr<CallInvoker> HermesWorkerHost::callInvoker() {
  return std::make_shared<InertInvoker>(invokerShared_);
}

uint32_t HermesWorkerHost::addTimer(
    std::shared_ptr<Function> cb,
    double ms,
    bool repeat) {
  uint32_t id;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    id = nextTimerId_++;
    Timer t;
    t.id = id;
    t.intervalMs = ms;
    t.repeat = repeat;
    t.cb = std::move(cb);
    t.deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(static_cast<long long>(ms < 0 ? 0 : ms));
    timers_.push_back(std::move(t));
  }
  // The caller may be a foreign thread running this worker's JS (Thread.run), so
  // wake the loop rather than assuming it will re-compute its wait on its own.
  cv_.notify_all();
  return id;
}

void HermesWorkerHost::clearTimer(uint32_t id) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (size_t i = 0; i < timers_.size(); ++i) {
    if (timers_[i].id == id) {
      timers_.erase(timers_.begin() + i);
      return;
    }
  }
}

void HermesWorkerHost::requestShutdown(bool immediate) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stop_ = true;
    if (immediate) immediate_ = true;
  }
  cv_.notify_all();
}

void HermesWorkerHost::runDueTimers(Runtime& rt) {
  auto now = std::chrono::steady_clock::now();
  std::vector<std::shared_ptr<Function>> toCall;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (size_t i = 0; i < timers_.size();) {
      if (timers_[i].deadline <= now) {
        toCall.push_back(timers_[i].cb);
        if (timers_[i].repeat) {
          timers_[i].deadline = now +
              std::chrono::milliseconds(
                  static_cast<long long>(timers_[i].intervalMs));
          ++i;
        } else {
          timers_.erase(timers_.begin() + i);
        }
      } else {
        ++i;
      }
    }
  }
  // Callbacks run OUTSIDE mutex_ (they re-enter addTimer/clearTimer) but INSIDE
  // the caller's WorkerJsScope, which is what serializes runtime access. The
  // scope also drains microtasks once, when the outermost entry unwinds.
  for (auto& fn : toCall) {
    runGuarded(rt, [&] { fn->call(rt); });
  }
  toCall.clear(); // release the jsi refs while the scope is still open
}

void HermesWorkerHost::threadMain(
    std::string prelude,
    std::string code,
    std::string sourceUrl,
    InstallFn install) {
  // Run the whole worker body (runtime creation, install, event loop, teardown)
  // under the platform thread scope so JNI-backed native modules resolve app
  // classes for the worker's entire lifetime (see WorkerThreadScope.h). Non-
  // Android platforms run the body directly.
  runInWorkerThreadScope([&]() {
#if defined(__APPLE__)
  // Referencing this is also what keeps the .mm defining it in the binary.
  installAppleAutoreleasePoolHooks();
#endif
  // Owns this thread's autorelease pool for the whole worker body. Popped
  // explicitly at teardown, BEFORE the runtime is destroyed — see
  // WorkerThreadScope.h for why the thread's implicit pool is too late.
  void* autoreleasePool = pushWorkerAutoreleasePool();
  ::hermes::vm::RuntimeConfig config =
      ::hermes::vm::RuntimeConfig::Builder()
          .withGCConfig(::hermes::vm::GCConfig::Builder()
                            .withMaxHeapSize(maxHeapMb_ << 20)
                            .withName("RNWorker")
                            .build())
          .withMicrotaskQueue(true)
          .build();

  std::unique_ptr<facebook::hermes::HermesRuntime> runtime =
      facebook::hermes::makeHermesRuntime(config);
  Runtime& rt = *runtime;

  // Publish the runtime to the lock BEFORE anything can enter it. From here on
  // every touch of `rt` — ours and any foreign thread's — happens inside a
  // WorkerJsScope. Cleared again during teardown below, under the same lock.
  {
    std::lock_guard<std::recursive_mutex> lock(lock_->mutex);
    lock_->runtime = &rt;
  }

  // Expose this runtime to the debugger as its own target, BEFORE any user code
  // runs, so breakpoints set in worker code at startup are not missed. Null (and
  // free) when the inspector is disabled, e.g. in release.
  std::unique_ptr<WorkerInspectorTarget> inspectorTarget;
  try {
    inspectorTarget = registerWorkerInspectorTarget(
        // Named workers use their name; unnamed ones fall back to the source
        // URL, so several concurrent workers are still tellable apart in the
        // target list rather than all showing as "Worker".
        "Worker: " + workerDisplayName(name_, sourceUrl),
        *runtime,
        // CDP commands arrive on the packager's socket thread; hop them onto
        // this worker's own JS thread, which is what post() does.
        [this](std::function<void()> fn) {
          post([fn = std::move(fn)](Runtime&) mutable { fn(); });
        });
  } catch (...) {
    // Debugger registration must never stop a worker from running.
  }

  // One scope around the whole startup sequence: a foreign thread must not be
  // able to enter while bindings are still being installed or the bundle is
  // mid-evaluation.
  {
    WorkerJsScope scope(lock_);

    try {
      install(rt);
      rt.evaluateJavaScript(
          std::make_shared<const StringBuffer>(std::move(prelude)),
          "rnworkers-prelude.js");
    } catch (const std::exception& e) {
      // Prelude failure is an internal bug; there is no onerror wired yet.
      // Nothing sensible to do but abort the worker — but unpublish the runtime
      // first, or a queued cross-thread entry would find a dangling pointer.
      lock_->runtime = nullptr;
      return;
    }

    runGuarded(rt, [&] {
      rt.evaluateJavaScript(
          std::make_shared<const StringBuffer>(std::move(code)), sourceUrl);
    });

    // Worker code may have pulled in RN's RCTDeviceEventEmitter module, which
    // replaces our prelude's `global.__rctDeviceEventEmitter` with a class
    // instance whose `emit` requires a correct receiver. Now that it has claimed
    // the global, make its `emit` receiver-independent so no native caller can
    // trip over it. No-op if the module was never imported.
    try {
      Value h = rt.global().getProperty(rt, "__rnworkersHardenDeviceEmitter");
      if (h.isObject() && h.asObject(rt).isFunction(rt)) {
        h.asObject(rt).asFunction(rt).call(rt);
      }
    } catch (...) {
    }
  }

  for (;;) {
    Task task;
    bool haveTask = false;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      auto taskPred = [this] { return stop_ || !tasks_.empty(); };
      while (!taskPred()) {
        if (!timers_.empty()) {
          // Sleep until the nearest deadline, or until a task arrives.
          auto nearest = timers_[0].deadline;
          for (auto& t : timers_) {
            if (t.deadline < nearest) nearest = t.deadline;
          }
          cv_.wait_until(lock, nearest, taskPred);
          // Either a task landed or a timer came due — both mean stop waiting.
          break;
        }
        // No timers right now, so an untimed wait is correct — but it must also
        // wake when a timer is ADDED. setTimeout can be called from a foreign
        // thread running this worker's JS (Thread.run), i.e. while we are parked
        // here; waking only on tasks would strand that timer forever.
        cv_.wait(lock, [this] {
          return stop_ || !tasks_.empty() || !timers_.empty();
        });
      }
      if (stop_ && (immediate_ || tasks_.empty())) {
        break;
      }
      if (!tasks_.empty()) {
        task = std::move(tasks_.front());
        tasks_.pop_front();
        haveTask = true;
      }
    }

    // Timers and the task share one scope: two entries in a row would drain
    // microtasks twice for no reason, and the recursive lock makes nesting free.
    {
      WorkerJsScope scope(lock_);
      runDueTimers(rt);
      if (haveTask) {
        runGuarded(rt, [&] { task(rt); });
        // Release the closure's jsi refs while the scope is still open, so its
        // end-of-iteration destruction has nothing left to free off-lock.
        task = nullptr;
      }
    }
  }
  // Pending timers hold `std::shared_ptr<jsi::Function>` and queued tasks hold
  // lambdas that may capture jsi values — all owned by THIS runtime. But
  // `timers_`/`tasks_` are members of the host, which outlives `threadMain`:
  // they would otherwise be destroyed when the host is, on the parent's thread,
  // *after* `runtime` below has already been destroyed. Releasing a jsi::Function
  // whose runtime is gone is a use-after-free (SIGSEGV in ~Timer). Any worker
  // terminated with a live setInterval / not-yet-fired setTimeout hits this.
  // Drop them here, on the worker thread, while the runtime is still alive.
  //
  // All of teardown runs inside one WorkerJsScope: every step below releases or
  // touches jsi values, and a foreign thread must not be able to enter JS
  // between the debugger target going away and the runtime being destroyed.
  {
    WorkerJsScope scope(lock_);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      timers_.clear();
      tasks_.clear();
    }

    // Drop the debugger target first: this closes any live session, so no CDP
    // command can be dispatched against a runtime we are about to destroy.
    inspectorTarget.reset();

    // Tear down per-worker native resources (e.g. the platform TurboModule
    // manager) while the runtime is still alive, then release the callback. This
    // is also where ThreadTargets are disposed — under this scope, as their
    // destructor contract requires.
    if (preDestroy_) {
      try {
        preDestroy_(rt);
      } catch (...) {
      }
      preDestroy_ = nullptr;
    }
  // A worker that imports `react-native` sets up RN's Blob support, which
  // installs a `__blobCollectorProvider` HostFunction capturing a jni::global_ref
  // to the Java BlobModule. RN releases that ref WITHOUT re-attaching the thread
  // (unlike ~BlobCollector, which wraps its JNI in a ThreadScope), so if the
  // HostFunction is finalized on Hermes's GC thread at teardown, DeleteGlobalRef
  // aborts — that thread is not attached to the JVM. Drop the reference and
  // collect now, on THIS (attached) worker thread, so the ref releases safely.
  // No-op when Blob was never set up. (Upstream RN bug in
  // BlobCollector::nativeInstall.)
    try {
      rt.global().setProperty(rt, "__blobCollectorProvider", Value::undefined());
      rt.instrumentation().collectGarbage("rnworkers-teardown");
    } catch (...) {
    }

    // Unpublish while still holding the lock: any thread that blocks on it from
    // here on wakes up, sees no runtime, and returns without touching it.
    lock_->runtime = nullptr;
  }

  // Drain every ObjC temporary this worker accumulated while its runtime is still
  // alive. Anything holding a jsi::Value (Expo's EXJavaScriptValue wrappers) is
  // released here rather than at pthread_exit, which happens after the runtime
  // below is gone.
  popWorkerAutoreleasePool(autoreleasePool);
  // `runtime` is destroyed here, on the worker thread.
  });
}

} // namespace facebook::react::workers
