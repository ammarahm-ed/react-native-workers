#include "WorkerThreads.h"

#include <string>
#include <unordered_map>
#include <utility>

#include "../runtime/ThreadTarget.h"

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

constexpr uint32_t kMainTargetId = 0;

void setHostFn(
    Runtime& rt,
    const char* name,
    unsigned paramCount,
    HostFunctionType fn) {
  rt.global().setProperty(
      rt,
      name,
      Function::createFromHostFunction(
          rt, PropNameID::forAscii(rt, name), paramCount, std::move(fn)));
}

// One in-flight Thread.run(). Lives in the worker-owned registry rather than in
// the posted closure, because a queued closure can be dropped at shutdown and
// destroyed with no runtime lock held (see ThreadTarget::post).
struct PendingCall {
  std::shared_ptr<Function> fn;    // released once it has run
  std::shared_ptr<Function> done;  // released once the promise settles
  std::shared_ptr<Value> result;   // moved across threads, read under the lock
  std::string message;
  std::string stack;
  bool failed = false;
};

// Per-worker binding state. Every field is touched only from inside a
// WorkerJsScope, so the runtime lock is also what guards this struct — no
// separate mutex.
struct ThreadsState {
  bool enabled = false;
  uint32_t nextId = 1; // 0 is reserved for the main thread
  uint64_t nextCallId = 1;
  std::unordered_map<uint32_t, std::shared_ptr<ThreadTarget>> targets;
  std::unordered_map<uint64_t, PendingCall> pending;
  std::shared_ptr<WorkerRuntimeLock> lock;
  std::function<void(std::function<void(Runtime&)>)> postToOwner;
};

void requireEnabled(Runtime& rt, const std::shared_ptr<ThreadsState>& state) {
  if (!state->enabled) {
    throw JSError(
        rt,
        "Multi-threading is experimental and disabled. Call "
        "global.enableMultiThreadingExperimental() in this worker first.");
  }
}

} // namespace

std::function<void()> installWorkerThreads(
    Runtime& rt,
    std::shared_ptr<WorkerRuntimeLock> lock,
    std::function<void(std::function<void(Runtime&)>)> postToOwner) {
  auto state = std::make_shared<ThreadsState>();
  state->lock = std::move(lock);
  state->postToOwner = std::move(postToOwner);

  setHostFn(
      rt,
      "__workerThreadsEnable",
      0,
      [state](Runtime&, const Value&, const Value*, size_t) -> Value {
        state->enabled = true;
        return Value(true);
      });

  // Resolves the main-thread target, registering it on first use. Throws where
  // UIWorker would also be unavailable.
  setHostFn(
      rt,
      "__workerThreadMain",
      0,
      [state](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        requireEnabled(rt, state);
        if (state->targets.find(kMainTargetId) == state->targets.end()) {
          auto target = mainThreadTarget();
          if (!target) {
            throw JSError(
                rt,
                "Thread.main is not available: no main-thread scheduler is "
                "registered on this platform.");
          }
          state->targets[kMainTargetId] = std::move(target);
        }
        return Value(static_cast<double>(kMainTargetId));
      });

  setHostFn(
      rt,
      "__workerThreadCreate",
      1,
      [state](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        requireEnabled(rt, state);
        std::string name = count > 0 && args[0].isString()
            ? args[0].getString(rt).utf8(rt)
            : "worker-thread";
        uint32_t id = state->nextId++;
        state->targets[id] = makeSerialThreadTarget(std::move(name));
        return Value(static_cast<double>(id));
      });

  setHostFn(
      rt,
      "__workerThreadDispose",
      1,
      [state](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        if (count < 1 || !args[0].isNumber()) return Value(false);
        auto id = static_cast<uint32_t>(args[0].getNumber());
        if (id == kMainTargetId) {
          throw JSError(rt, "Thread.main cannot be disposed.");
        }
        auto it = state->targets.find(id);
        if (it == state->targets.end()) return Value(false);
        // Signals the thread and returns; it unwinds on its own. In-flight calls
        // already inside a scope still settle — their entries stay in `pending`.
        state->targets.erase(it);
        return Value(true);
      });

  setHostFn(
      rt,
      "__workerThreadCurrent",
      0,
      [](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return String::createFromUtf8(rt, currentThreadTargetName());
      });

  // __workerThreadRun(id, fn, done)
  //
  // Runs `fn` on the target's thread — this worker's own runtime, entered there
  // through a WorkerJsScope — then settles back on the worker's own thread by
  // calling done(message | null, stack | null, value).
  setHostFn(
      rt,
      "__workerThreadRun",
      3,
      [state](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        requireEnabled(rt, state);
        if (count < 3 || !args[1].isObject() ||
            !args[1].getObject(rt).isFunction(rt) || !args[2].isObject() ||
            !args[2].getObject(rt).isFunction(rt)) {
          throw JSError(rt, "__workerThreadRun expects (id, fn, done).");
        }
        auto targetId =
            static_cast<uint32_t>(args[0].isNumber() ? args[0].getNumber() : -1);
        auto targetIt = state->targets.find(targetId);
        if (targetIt == state->targets.end()) {
          throw JSError(rt, "Thread has been disposed or was never created.");
        }

        uint64_t callId = state->nextCallId++;
        PendingCall call;
        call.fn =
            std::make_shared<Function>(args[1].getObject(rt).getFunction(rt));
        call.done =
            std::make_shared<Function>(args[2].getObject(rt).getFunction(rt));
        state->pending.emplace(callId, std::move(call));

        // The closure captures only ids and non-jsi handles, so dropping it at
        // shutdown is safe. `state` is co-owned: the binding outlives the target.
        std::weak_ptr<ThreadsState> weakState = state;
        auto lock = state->lock;
        targetIt->second->post([weakState, lock, callId]() {
          // On the target's thread now.
          WorkerJsScope scope(lock);
          auto state = weakState.lock();
          if (!state || !scope.alive()) return;
          auto it = state->pending.find(callId);
          if (it == state->pending.end()) return;
          PendingCall& call = it->second;
          Runtime& rt = scope.runtime();

          try {
            call.result = std::make_shared<Value>(call.fn->call(rt));
          } catch (const JSError& e) {
            call.failed = true;
            call.message = e.getMessage();
            call.stack = e.getStack();
          } catch (const std::exception& e) {
            call.failed = true;
            call.message = e.what();
          }
          call.fn = nullptr; // released under the lock

          if (!state->postToOwner) return;
          // Settle on the worker's OWN thread, so `await` never resumes user
          // code on a foreign one.
          state->postToOwner([weakState, callId](Runtime& ownerRt) {
            auto state = weakState.lock();
            if (!state) return;
            auto it = state->pending.find(callId);
            if (it == state->pending.end()) return;
            PendingCall call = std::move(it->second);
            state->pending.erase(it);

            Value err = call.failed
                ? Value(String::createFromUtf8(ownerRt, call.message))
                : Value::null();
            Value stack = call.failed
                ? Value(String::createFromUtf8(ownerRt, call.stack))
                : Value::null();
            Value value =
                call.result ? Value(ownerRt, *call.result) : Value::undefined();
            try {
              call.done->call(
                  ownerRt, std::move(err), std::move(stack), std::move(value));
            } catch (...) {
              // A throwing settle handler is a prelude bug; nothing to report to.
            }
          });
        });

        return Value::undefined();
      });

  return [state]() {
    // Runs on the worker thread inside a WorkerJsScope (see setPreDestroy), so
    // this is where every rooted callback and captured result is released.
    state->pending.clear();
    state->targets.clear();
    state->postToOwner = nullptr;
  };
}

} // namespace facebook::react::workers
