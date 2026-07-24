#include "Worker.h"

#include "../bindings/WorkerGlobalScope.h"
#include "../bindings/WorkerPrelude.h"
#include "../bindings/WorkerTurboModules.h"
#include "../runtime/HermesWorkerHost.h"
#include "../runtime/MainThreadScheduler.h"
#include "../runtime/UiWorkerHost.h"
#include "SharedBuffer.h"
#include "SharedStore.h"
#include "SharedValue.h"

#include <cstdio>
#include <utility>

#if defined(__ANDROID__)
#include <android/log.h>
#endif

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {
void platformLog(
    uint32_t id,
    const std::string& level,
    const std::string& text) {
#if defined(__ANDROID__)
  int prio = ANDROID_LOG_INFO;
  if (level == "warn") prio = ANDROID_LOG_WARN;
  else if (level == "error") prio = ANDROID_LOG_ERROR;
  else if (level == "debug") prio = ANDROID_LOG_DEBUG;
  __android_log_print(prio, "RNWorker", "[%u] %s", id, text.c_str());
#else
  fprintf(stderr, "[RNWorker %u] %s: %s\n", id, level.c_str(), text.c_str());
#endif
}
} // namespace

Worker::Worker(
    uint32_t id,
    std::string name,
    uint32_t maxHeapMb,
    HostDelivery* delivery,
    bool ui,
    bool nativeModules,
    bool inspectable)
    : id_(id),
      name_(std::move(name)),
      maxHeapMb_(maxHeapMb),
      delivery_(delivery),
      ui_(ui),
      nativeModules_(nativeModules),
      inspectable_(inspectable) {}

Worker::~Worker() = default;

WorkerHooks Worker::makeHooks(const std::string& sourceUrl) {
  WorkerHooks h;
  h.sourceUrl = sourceUrl;
  uint32_t id = id_;
  HostDelivery* d = delivery_;
  WorkerRuntimeHost* host = host_.get();

  h.onPostMessage = [d, id](Message message) {
    d->deliverMessage(id, std::move(message));
  };
  h.onClose = [d, id, host] {
    host->requestShutdown(/*immediate=*/false);
    d->workerClosed(id);
  };
  h.onLog = [d, id](const std::string& level, const std::string& text) {
    // Both destinations on purpose: the platform log keeps working when no JS
    // host is attached (native-API workers, early startup), and the host gets a
    // tagged copy so worker output shows up where app logs already are.
    platformLog(id, level, text);
    d->deliverLog(id, level, text);
  };
  h.onReportError = [d, id](WorkerError e) {
    d->deliverError(id, std::move(e));
  };
  h.onSetTimer = [host](
                     std::shared_ptr<Function> cb, double ms, bool repeat) {
    return host->addTimer(std::move(cb), ms, repeat);
  };
  h.onClearTimer = [host](uint32_t tid) { host->clearTimer(tid); };
  h.onEnableDeviceEvents = [d, id] { d->enableDeviceEvents(id); };
  return h;
}

void Worker::start(std::string code, std::string sourceUrl) {
  if (ui_) {
    auto scheduler = getMainThreadScheduler();
    if (!scheduler) {
      WorkerError err;
      err.message =
          "UIWorker is not available: no main-thread scheduler is registered "
          "on this platform.";
      delivery_->deliverError(id_, std::move(err));
      return;
    }
    host_ =
        std::make_unique<UiWorkerHost>(name_, maxHeapMb_, scheduler, inspectable_);
  } else {
    host_ = std::make_unique<HermesWorkerHost>(name_, maxHeapMb_);
  }
  std::string url = sourceUrl;
  // Capture everything the worker thread needs BY VALUE now, on the host thread.
  // The install lambda must NOT touch `this` (the Worker) or `host_` (the
  // unique_ptr): the Worker can be reaped while its thread is still starting up,
  // and unique_ptr destruction nulls the pointer *before* the host destructor
  // joins the thread — so a worker-thread read of host_ could see null and crash.
  // The host outlives its own thread (its destructor joins), so a raw host
  // pointer and its CallInvoker stay valid throughout, and the host owns the
  // per-worker TurboModule manager lifetime via retain().
  WorkerRuntimeHost* host = host_.get();
  auto workerInvoker = host_->callInvoker();
  WorkerHooks hooks = makeHooks(url);
  bool nativeModules = nativeModules_;
  host_->start(
      kWorkerPrelude,
      std::move(code),
      url,
      [host, workerInvoker, hooks = std::move(hooks), nativeModules](
          Runtime& rt) {
        installWorkerGlobalScope(rt, hooks);
        // Native modules (incl. nested Worker creation) available in the worker.
        // The heavy platform (Java/ObjC) manager is only built when opted in; its
        // cleanup runs on the worker thread before the runtime is destroyed.
        auto tmCleanup =
            installWorkerTurboModules(rt, workerInvoker, nativeModules);
        // SharedStore: schedule this worker's watcher callbacks on its own loop.
        // Post through the worker's CallInvoker, NOT the raw host: a SharedStore
        // subscription lives in the process-global store and can outlive this
        // worker (terminate does not unsubscribe it), so a later set()/delete()
        // from any runtime will call this poster after the host is gone. The
        // CallInvoker goes inert when the host is destroyed (drops the task
        // safely), whereas a raw `host->post` would dereference freed memory.
        auto storeCleanup =
            installSharedStore(rt, [workerInvoker](std::function<void(Runtime&)> fn) {
              workerInvoker->invokeAsync(std::move(fn));
            });
        // SharedValue: same safe-poster contract as SharedStore.
        auto valueCleanup =
            installSharedValue(rt, [workerInvoker](std::function<void(Runtime&)> fn) {
              workerInvoker->invokeAsync(std::move(fn));
            });
        // SharedBuffer: raw shared memory + named locks (no callbacks/cleanup).
        installSharedBuffer(rt);
        // Run the teardowns on the worker thread with the runtime still alive,
        // right before it is destroyed: drop this worker's store/value
        // subscriptions (so no stale callback lingers), then invalidate the
        // platform TurboModule manager.
        host->setPreDestroy([storeCleanup = std::move(storeCleanup),
                             valueCleanup = std::move(valueCleanup),
                             tmCleanup = std::move(tmCleanup)](Runtime& rt) {
          if (storeCleanup) storeCleanup(rt);
          if (valueCleanup) valueCleanup(rt);
          if (tmCleanup) tmCleanup(rt);
        });
      });
}

void Worker::deliverToWorker(Message message) {
  if (!host_) return;
  auto shared = std::make_shared<Message>(std::move(message));
  host_->post([shared](Runtime& rt) {
    try {
      Value v = decode(rt, *shared);
      rt.global()
          .getPropertyAsFunction(rt, "__rnworkersDispatchMessage")
          .call(rt, std::move(v));
    } catch (...) {
      try {
        rt.global()
            .getPropertyAsFunction(rt, "__rnworkersDispatchMessageError")
            .call(rt);
      } catch (...) {
      }
    }
  });
}

void Worker::deliverDeviceEvent(std::shared_ptr<Message> eventArgs) {
  if (!host_ || !eventArgs) return;
  host_->post([eventArgs](Runtime& rt) {
    try {
      Value v = decode(rt, *eventArgs);
      Value fn = rt.global().getProperty(rt, "__rnworkersDispatchDeviceEvent");
      if (fn.isObject() && fn.asObject(rt).isFunction(rt)) {
        fn.asObject(rt).asFunction(rt).call(rt, std::move(v));
      }
    } catch (...) {
    }
  });
}

void Worker::deliverJsonToWorker(std::string json) {
  if (!host_) return;
  auto shared = std::make_shared<std::string>(std::move(json));
  host_->post([shared](Runtime& rt) {
    try {
      Value parsed = rt.global()
                         .getPropertyAsObject(rt, "JSON")
                         .getPropertyAsFunction(rt, "parse")
                         .call(rt, String::createFromUtf8(rt, *shared));
      rt.global()
          .getPropertyAsFunction(rt, "__rnworkersDispatchMessage")
          .call(rt, std::move(parsed));
    } catch (...) {
    }
  });
}

void Worker::terminate() {
  if (host_) host_->requestShutdown(/*immediate=*/true);
}

} // namespace facebook::react::workers
