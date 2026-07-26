#include "UiWorkerHost.h"

#include <ReactCommon/CallInvoker.h>
#include <hermes/Public/GCConfig.h>
#include <hermes/Public/RuntimeConfig.h>
#include <hermes/hermes.h>

#include <utility>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

void reportUncaught(Runtime& rt, const Value& err) {
  try {
    rt.global()
        .getPropertyAsFunction(rt, "__rnworkersReportError")
        .call(rt, Value(rt, err));
  } catch (...) {
  }
}

void runGuarded(Runtime& rt, const std::function<void()>& fn) {
  try {
    fn();
  } catch (const JSError& e) {
    reportUncaught(rt, e.value());
  } catch (const std::exception& e) {
    reportUncaught(rt, Value(String::createFromUtf8(rt, e.what())));
  }
}

// A readable target name for the debugger list; mirrors HermesWorkerHost.
std::string uiWorkerDisplayName(
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
  if (dot != std::string::npos) s = s.substr(0, dot);
  return s.empty() ? "anonymous" : s;
}

} // namespace

UiWorkerHost::UiWorkerHost(
    std::string name,
    uint32_t maxHeapMb,
    std::shared_ptr<MainThreadScheduler> scheduler,
    bool inspectable)
    : name_(std::move(name)),
      scheduler_(std::move(scheduler)),
      inspectable_(inspectable),
      state_(std::make_shared<State>()) {
  state_->maxHeapMb = maxHeapMb ? maxHeapMb : 256;
  state_->scheduler = scheduler_;
}

UiWorkerHost::~UiWorkerHost() {
  // Destroy the runtime + timers on the main thread (jsi objects are
  // thread-affine). Capturing `state` keeps it alive until the task runs.
  auto state = state_;
  state->stopped.store(true);
  if (scheduler_) {
    scheduler_->post([state]() {
      // Drop the debugger target first: this closes any live session, so no CDP
      // command can be dispatched against a runtime we are about to destroy.
      state->inspectorTarget.reset();
      // Tear down native resources while the runtime is still alive.
      if (state->preDestroy && state->runtime) {
        try {
          state->preDestroy(*state->runtime);
        } catch (...) {
        }
        state->preDestroy = nullptr;
      }
      state->timers.clear();
      state->runtime.reset();
    });
  }
}

void UiWorkerHost::start(
    std::string prelude,
    std::string code,
    std::string sourceUrl,
    InstallFn install) {
  auto state = state_;
  auto scheduler = scheduler_;
  bool inspectable = inspectable_;
  std::string title = "UIWorker: " + uiWorkerDisplayName(name_, sourceUrl);
  scheduler_->post([state, scheduler, inspectable, title,
                    prelude = std::move(prelude), code = std::move(code),
                    sourceUrl = std::move(sourceUrl),
                    install = std::move(install)]() {
    ::hermes::vm::RuntimeConfig config =
        ::hermes::vm::RuntimeConfig::Builder()
            .withGCConfig(::hermes::vm::GCConfig::Builder()
                              .withMaxHeapSize(state->maxHeapMb << 20)
                              .withName("RNUiWorker")
                              .build())
            .withMicrotaskQueue(true)
            .build();
    auto hermesRuntime = facebook::hermes::makeHermesRuntime(config);
    // Grab the concrete-type reference before moving ownership into `state`
    // (a unique_ptr move keeps the same object, so the reference stays valid).
    facebook::hermes::HermesRuntime& hermesRt = *hermesRuntime;
    state->runtime = std::move(hermesRuntime);
    Runtime& rt = *state->runtime;

    // Opt-in debugger target. Registered BEFORE user code so early breakpoints
    // are honoured. WARNING: this runtime is on the platform main thread, so a
    // debugger pause holds the UI thread — the app freezes until you resume, and
    // the OS may kill it. Off by default; see the UIWorker guide. Null in release
    // (Fusebox disabled) even when requested.
    if (inspectable) {
      try {
        state->inspectorTarget = registerWorkerInspectorTarget(
            title, hermesRt, [state, scheduler](std::function<void()> fn) {
              // CDP commands arrive on the packager socket thread; run them on
              // the worker's own (main) thread.
              scheduler->post([state, fn = std::move(fn)]() mutable {
                if (state->runtime && !state->stopped.load()) fn();
              });
            });
      } catch (...) {
        // Debugger registration must never stop a worker from running.
      }
    }

    try {
      install(rt);
      rt.evaluateJavaScript(
          std::make_shared<const StringBuffer>(prelude),
          "rnworkers-prelude.js");
      rt.drainMicrotasks();
    } catch (...) {
      return;
    }
    runGuarded(rt, [&] {
      rt.evaluateJavaScript(
          std::make_shared<const StringBuffer>(code), sourceUrl);
    });
    rt.drainMicrotasks();
  });
}

void UiWorkerHost::post(Task&& task) {
  auto state = state_;
  scheduler_->post([state, task = std::move(task)]() {
    if (state->runtime && !state->stopped.load()) {
      runGuarded(*state->runtime, [&] { task(*state->runtime); });
      state->runtime->drainMicrotasks();
    }
  });
}

std::shared_ptr<CallInvoker> UiWorkerHost::callInvoker() {
  auto state = state_;
  auto sched = scheduler_;
  // A minimal CallInvoker that schedules CallFuncs onto the UI thread.
  struct Invoker : CallInvoker {
    std::shared_ptr<State> state;
    std::shared_ptr<MainThreadScheduler> sched;
    void invokeAsync(CallFunc&& func) noexcept override {
      auto s = state;
      sched->post([s, func = std::move(func)]() mutable {
        if (s->runtime && !s->stopped.load()) {
          func(*s->runtime);
          s->runtime->drainMicrotasks();
        }
      });
    }
    void invokeSync(CallFunc&&) override {
      throw std::runtime_error("invokeSync is not supported for workers");
    }
  };
  auto inv = std::make_shared<Invoker>();
  inv->state = state;
  inv->sched = sched;
  return inv;
}

void UiWorkerHost::scheduleTimer(
    std::shared_ptr<State> state,
    uint32_t id,
    std::shared_ptr<TimerState> ts) {
  // No `this` in the delayed lambda: the host can be destroyed (off-thread, via
  // reap) while a delayed timer is still pending, so everything the callback
  // needs — scheduler included — must come from the shared State it captures.
  auto* scheduler = state->scheduler.get();
  scheduler->postDelayed(
      [state, id, ts]() {
        if (!ts->alive->load() || !state->runtime || state->stopped.load()) {
          return;
        }
        runGuarded(*state->runtime, [&] { ts->cb->call(*state->runtime); });
        state->runtime->drainMicrotasks();
        if (ts->repeat && ts->alive->load() && !state->stopped.load()) {
          scheduleTimer(state, id, ts);
        } else {
          state->timers.erase(id);
        }
      },
      ts->intervalMs);
}

uint32_t UiWorkerHost::addTimer(
    std::shared_ptr<Function> cb,
    double ms,
    bool repeat) {
  // Called on the main thread (from a worker host function).
  uint32_t id = state_->nextTimerId++;
  auto ts = std::make_shared<TimerState>();
  ts->cb = std::move(cb);
  ts->intervalMs = ms < 0 ? 0 : ms;
  ts->repeat = repeat;
  ts->alive = std::make_shared<std::atomic<bool>>(true);
  state_->timers[id] = ts;
  scheduleTimer(state_, id, std::move(ts));
  return id;
}

void UiWorkerHost::clearTimer(uint32_t id) {
  auto it = state_->timers.find(id);
  if (it != state_->timers.end()) {
    it->second->alive->store(false);
    state_->timers.erase(it);
  }
}

void UiWorkerHost::requestShutdown(bool /*immediate*/) {
  state_->stopped.store(true);
}

} // namespace facebook::react::workers
