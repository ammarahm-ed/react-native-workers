#include "ReactNativeWorkersImpl.h"

#include <ReactCommon/CxxTurboModuleUtils.h>
#include <jsi/instrumentation.h>

#include "api/NativeWorkers.h"
#include "bindings/WorkerGlobalScope.h"
#include "core/MessageCodec.h"
#include "core/SharedBuffer.h"
#include "core/SharedStore.h"
#include "core/SharedValue.h"
#include "runtime/WorkerAssetReader.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

#if defined(__ANDROID__)
#include <android/log.h>
#endif

namespace facebook::react {

using namespace facebook::jsi;
using workers::DataCloneError;
using workers::Message;
using workers::Worker;
using workers::WorkerError;

namespace {
// Bundled-worker loading is a build-configuration concern that only shows up in
// release, where there is no Metro and no JS console to inspect. Log the path
// each bundled worker takes to the platform log, so a release build can be
// diagnosed with `adb logcat -s RNWorkerAsset` / the simulator console.
void assetLog(const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
#if defined(__ANDROID__)
  __android_log_vprint(ANDROID_LOG_INFO, "RNWorkerAsset", fmt, args);
#else
  fprintf(stderr, "[RNWorkerAsset] ");
  vfprintf(stderr, fmt, args);
  fprintf(stderr, "\n");
#endif
  va_end(args);
}

// Hermes bytecode file magic (little-endian 0x1F1903C103BC1FC6) — the same value
// Hermes sniffs for in evaluateJavaScript to choose the HBC path. Checked only
// so the log can report which format actually shipped; the evaluate path itself
// does not branch on it.
bool looksLikeHermesBytecode(const std::string& bytes) {
  static const unsigned char kMagic[] = {
      0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f};
  if (bytes.size() < sizeof(kMagic)) return false;
  return std::memcmp(bytes.data(), kMagic, sizeof(kMagic)) == 0;
}

// Destroy a worker (which joins its thread) off the host JS thread so
// terminate()/close cleanup never blocks the app's JS thread.
void reap(std::shared_ptr<Worker> worker) {
  if (!worker) return;
  std::thread([w = std::move(worker)]() mutable { w.reset(); }).detach();
}
} // namespace

ReactNativeWorkersImpl::ReactNativeWorkersImpl(
    std::shared_ptr<CallInvoker> jsInvoker)
    : NativeReactNativeWorkersCxxSpec(std::move(jsInvoker)) {
  // Ensure this module is in the global Cxx map so worker runtimes can resolve
  // it via TurboModuleBinding. iOS's OnLoad registers it too; on Android
  // autolinking does NOT populate the global map, so we do it here (once).
  static std::once_flag once;
  std::call_once(once, [] {
    registerCxxModuleToGlobalModuleMap(
        std::string(ReactNativeWorkersImpl::kModuleName),
        [](std::shared_ptr<CallInvoker> ji) {
          return std::make_shared<ReactNativeWorkersImpl>(std::move(ji));
        });
  });
}

ReactNativeWorkersImpl::~ReactNativeWorkersImpl() {
  // Tear down all runtimes off-thread on module destruction (e.g. app reload).
  for (auto& entry : runtimes_) {
    entry.second->terminate();
    reap(entry.second);
  }
  runtimes_.clear();
  runtimeConnections_.clear();
  connRuntime_.clear();
  uiRuntimes_.clear();
  runtimeUrl_.clear();
  deviceEventRuntimes_.clear();
}

bool ReactNativeWorkersImpl::install(jsi::Runtime& rt) {
  ReactNativeWorkersImpl* self = this;
  rt.global().setProperty(
      rt,
      "__RNWorkersPostMessage",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__RNWorkersPostMessage"),
          3,
          [self](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 2 || !args[0].isNumber()) return Value::undefined();
            // arg 0 is a connection id; route to the runtime it's attached to.
            auto connId = static_cast<uint32_t>(args[0].getNumber());
            auto rit = self->connRuntime_.find(connId);
            if (rit == self->connRuntime_.end()) return Value::undefined();
            auto it = self->runtimes_.find(rit->second);
            if (it == self->runtimes_.end()) return Value::undefined();
            try {
              Message msg = workers::encode(rt, args[1]);
              it->second->deliverToWorker(std::move(msg));
            } catch (const DataCloneError& e) {
              throw JSError(rt, e.what());
            }
            return Value::undefined();
          }));
  workers::installStructuredClone(rt);
  // SharedStore: schedule watcher callbacks on the host JS thread.
  auto hostInvoker = jsInvoker_;
  workers::installSharedStore(
      rt, [hostInvoker](std::function<void(Runtime&)> fn) {
        hostInvoker->invokeAsync(std::move(fn));
      });
  workers::installSharedValue(
      rt, [hostInvoker](std::function<void(Runtime&)> fn) {
        hostInvoker->invokeAsync(std::move(fn));
      });
  workers::installSharedBuffer(rt);
  // Diagnostic/test hook: force a full GC on THIS runtime. Shared data is freed
  // by refcount, and the last reference is usually a JS handle, so releasing it
  // only takes effect once the collector runs. Tests need that to be observable
  // rather than "eventually"; production code should never need to call it.
  rt.global().setProperty(
      rt,
      "__rnworkersCollectGarbage",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersCollectGarbage"),
          0,
          [](Runtime& rt, const Value&, const Value*, size_t) -> Value {
            rt.instrumentation().collectGarbage("rnworkers-test");
            return Value::undefined();
          }));
  installDeviceEventBridge(rt);
  return true;
}

void ReactNativeWorkersImpl::installDeviceEventBridge(Runtime& rt) {
  // Wrap global.__rctDeviceEventEmitter.emit (installed by RN core before app
  // code) so every host device event is also forwarded to opted-in workers. Cheap
  // when no worker is listening (early-out on the empty set).
  Value emitterVal = rt.global().getProperty(rt, "__rctDeviceEventEmitter");
  if (!emitterVal.isObject()) return;
  Object emitter = emitterVal.asObject(rt);
  Value emitVal = emitter.getProperty(rt, "emit");
  if (!emitVal.isObject() || !emitVal.asObject(rt).isFunction(rt)) return;

  auto original =
      std::make_shared<Function>(emitVal.asObject(rt).asFunction(rt));
  ReactNativeWorkersImpl* self = this;
  emitter.setProperty(
      rt,
      "emit",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "emit"),
          1,
          [self, original](
              Runtime& rt, const Value& thisVal, const Value* args, size_t count)
              -> Value {
            if (!self->deviceEventRuntimes_.empty() && count >= 1 &&
                args[0].isString()) {
              try {
                Array arr(rt, count);
                for (size_t i = 0; i < count; ++i) {
                  arr.setValueAtIndex(rt, i, Value(rt, args[i]));
                }
                auto msg = std::make_shared<Message>(
                    workers::encode(rt, Value(std::move(arr))));
                // Once per runtime, not per connection.
                for (uint32_t runtimeId : self->deviceEventRuntimes_) {
                  auto it = self->runtimes_.find(runtimeId);
                  if (it != self->runtimes_.end()) {
                    it->second->deliverDeviceEvent(msg);
                  }
                }
              } catch (...) {
                // Non-cloneable event payload: skip forwarding, still deliver
                // to the host below.
              }
            }
            if (thisVal.isObject()) {
              return original->callWithThis(
                  rt, thisVal.asObject(rt), args, count);
            }
            return original->call(rt, args, count);
          }));
}

double ReactNativeWorkersImpl::createWorkerImpl(
    std::string kind,
    std::string value,
    std::string sourceUrl,
    std::string name,
    bool ui,
    bool nativeModules,
    bool shared,
    bool inspectable) {
  uint32_t connId = nextId_++;

  // Reconnect: a shared UIWorker whose URL already has a persistent runtime just
  // attaches a new connection — the script is NOT re-evaluated. Worker->host
  // deliveries will fan out to this connection too; the bridge re-announces its
  // modules to the newcomer via the `hello` handshake.
  if (shared && !sourceUrl.empty()) {
    auto existing = uiRuntimes_.find(sourceUrl);
    if (existing != uiRuntimes_.end()) {
      uint32_t runtimeId = existing->second;
      connRuntime_[connId] = runtimeId;
      runtimeConnections_[runtimeId].push_back(connId);
      return static_cast<double>(connId);
    }
  }

  // Fresh runtime. Its own id doubles as the runtime id; the first connection
  // and the runtime share that id.
  uint32_t runtimeId = connId;
  auto worker = std::make_shared<Worker>(
      runtimeId, std::move(name), 256, this, ui, nativeModules, inspectable);
  runtimes_[runtimeId] = worker;
  runtimeConnections_[runtimeId] = {connId};
  connRuntime_[connId] = runtimeId;
  if (shared && !sourceUrl.empty()) {
    uiRuntimes_[sourceUrl] = runtimeId;
    runtimeUrl_[runtimeId] = sourceUrl;
  }

  if (kind == "inline") {
    worker->start(std::move(value), sourceUrl);
  } else if (kind == "asset") {
    // Release path: the bundle was built by the CLI and shipped in the app.
    // The bytes may be plain JS or Hermes bytecode (the CLI runs hermesc when
    // available, keeping the .jsbundle name) — Hermes detects the HBC magic on
    // evaluate, so there is nothing to branch on here.
    auto reader = workers::getWorkerAssetReader();
    if (!reader) {
      assetLog("no asset reader registered; cannot load '%s'", value.c_str());
      WorkerError err;
      err.message =
          "Cannot load bundled worker '" + value +
          "': no asset reader is registered for this platform. Bundled workers "
          "require the release worker-bundling build step.";
      err.filename = sourceUrl;
      deliverError(runtimeId, std::move(err));
      return static_cast<double>(connId);
    }

    std::string bytes;
    std::string error;
    if (!reader->read(value, bytes, error)) {
      assetLog("read FAILED '%s': %s", value.c_str(), error.c_str());
      WorkerError err;
      // A missing bundle is a build-configuration mistake, so name the asset and
      // point at the step that produces it rather than failing generically.
      err.message = "Failed to load bundled worker '" + value + "': " + error +
          ". Was `rn-workers-bundle` run for this build?";
      err.filename = sourceUrl;
      deliverError(runtimeId, std::move(err));
      return static_cast<double>(connId);
    }
    assetLog(
        "loaded '%s' (%zu bytes, %s) -> worker %u",
        value.c_str(),
        bytes.size(),
        looksLikeHermesBytecode(bytes) ? "hermes bytecode" : "plain JS",
        runtimeId);
    worker->start(std::move(bytes), sourceUrl);
  } else {
    // "url" is resolved in JS (dev fetches from Metro and re-enters as inline),
    // so reaching here means an unexpected kind.
    WorkerError err;
    err.message = "Unsupported worker source kind '" + kind + "'.";
    err.filename = sourceUrl;
    deliverError(runtimeId, std::move(err));
  }
  return static_cast<double>(connId);
}

double ReactNativeWorkersImpl::createWorker(
    jsi::Runtime&,
    std::string kind,
    std::string value,
    std::string sourceUrl,
    std::string name,
    bool nativeModules) {
  // Background workers are always private (1:1), matching the Web Worker model,
  // and always inspectable in dev (the inspector target is free there).
  return createWorkerImpl(
      std::move(kind), std::move(value), std::move(sourceUrl), std::move(name),
      /*ui=*/false, nativeModules, /*shared=*/false, /*inspectable=*/true);
}

double ReactNativeWorkersImpl::createUIWorker(
    jsi::Runtime&,
    std::string kind,
    std::string value,
    std::string sourceUrl,
    std::string name,
    bool nativeModules,
    bool independent,
    bool inspectable) {
  return createWorkerImpl(
      std::move(kind), std::move(value), std::move(sourceUrl), std::move(name),
      /*ui=*/true, nativeModules, /*shared=*/!independent, inspectable);
}

// Detach one connection (a JS handle). For a shared runtime this leaves the
// runtime and its other connections untouched — and never reaps it, even when
// the last connection goes (the runtime is persistent by design; use
// terminateUIWorkerRuntime to actually reap it). For a private runtime the last
// (only) connection leaving reaps it.
void ReactNativeWorkersImpl::terminate(jsi::Runtime&, double id) {
  auto connId = static_cast<uint32_t>(id);
  auto cit = connRuntime_.find(connId);
  if (cit == connRuntime_.end()) return;
  uint32_t runtimeId = cit->second;

  connRuntime_.erase(cit);
  auto& conns = runtimeConnections_[runtimeId];
  conns.erase(std::remove(conns.begin(), conns.end(), connId), conns.end());

  const bool sharedRuntime = runtimeUrl_.count(runtimeId) != 0;
  if (!sharedRuntime && conns.empty()) {
    // Private (background / independent) runtime: reap when its only handle goes.
    reapRuntime(runtimeId);
  }
}

// Force-reap the persistent shared runtime for a URL, dropping every handle.
void ReactNativeWorkersImpl::terminateUIWorkerRuntime(
    jsi::Runtime&,
    std::string sourceUrl) {
  auto it = uiRuntimes_.find(sourceUrl);
  if (it == uiRuntimes_.end()) return;
  reapRuntime(it->second);
}

void ReactNativeWorkersImpl::reapRuntime(uint32_t runtimeId) {
  auto rit = runtimes_.find(runtimeId);
  if (rit == runtimes_.end()) return;
  rit->second->terminate();
  reap(rit->second);
  runtimes_.erase(rit);

  auto conns = runtimeConnections_.find(runtimeId);
  if (conns != runtimeConnections_.end()) {
    for (uint32_t connId : conns->second) {
      connRuntime_.erase(connId);
    }
    runtimeConnections_.erase(conns);
  }
  deviceEventRuntimes_.erase(runtimeId);
  auto url = runtimeUrl_.find(runtimeId);
  if (url != runtimeUrl_.end()) {
    uiRuntimes_.erase(url->second);
    runtimeUrl_.erase(url);
  }
}

AsyncPromise<std::string> ReactNativeWorkersImpl::nativeWorkerSelfTest(
    jsi::Runtime& rt) {
  auto promise = std::make_shared<AsyncPromise<std::string>>(rt, jsInvoker_);

  // A worker created entirely from native C++ (no JS involvement), echoing back.
  class Delegate : public workers::NativeWorkerDelegate {
   public:
    std::shared_ptr<AsyncPromise<std::string>> promise;
    uint32_t id = 0;
    void onMessage(const std::string& json) override {
      promise->resolve(json);
      if (id) workers::NativeWorkers::terminate(id);
    }
    void onError(const std::string& message) override {
      promise->resolve(std::string("ERROR: ") + message);
      if (id) workers::NativeWorkers::terminate(id);
    }
  };

  auto delegate = std::make_shared<Delegate>();
  delegate->promise = promise;
  static const std::string kCode =
      "self.onmessage = function (e) {"
      "  self.postMessage({ fromNativeWorker: true, got: e.data });"
      "};";
  uint32_t id =
      workers::NativeWorkers::create(kCode, delegate, "native-selftest");
  delegate->id = id;
  workers::NativeWorkers::postMessage(id, "{\"hello\":\"from-native\"}");

  return *promise;
}

void ReactNativeWorkersImpl::postToHost(std::function<void(Runtime&)> task) {
  // Fast path: a native wakeup of the host JS thread, no JVM boundary. Once
  // installed this is a queue push plus one write() syscall.
  if (hostWaker_) {
    hostWaker_->post(std::move(task));
    return;
  }

  // Not installed yet. Installation must happen ON the host JS thread (the
  // looper and the runtime are both thread-local), so the FIRST delivery goes
  // through the CallInvoker and installs the waker while it is there. Every
  // later delivery takes the fast path above.
  //
  // hostWakerTried_ is only read/written inside this host-thread callback, so
  // it needs no synchronisation, and a failed install is never retried.
  jsInvoker_->invokeAsync(
      [this, task = std::move(task)](Runtime& rt) mutable {
        if (!hostWakerTried_) {
          hostWakerTried_ = true;
          hostWaker_ = workers::createHostThreadWaker(rt);
        }
        task(rt);
      });
}

void ReactNativeWorkersImpl::deliverMessage(
    uint32_t runtimeId,
    Message message) {
  // `runtimeId` is the Worker's own id; fan the delivery out to every connection
  // (JS handle) currently attached to that runtime. Connection membership is read
  // here on the host JS thread, where it is exclusively mutated.
  auto shared = std::make_shared<Message>(std::move(message));
  postToHost([this, runtimeId, shared](Runtime& rt) {
    auto it = runtimeConnections_.find(runtimeId);
    if (it == runtimeConnections_.end()) return;
    auto deliver = rt.global().getProperty(rt, "__rnworkersDeliver");
    if (!deliver.isObject() || !deliver.asObject(rt).isFunction(rt)) return;
    jsi::Function fn = deliver.asObject(rt).asFunction(rt);
    for (uint32_t connId : it->second) {
      try {
        Value v = workers::decode(rt, *shared);
        fn.call(
            rt,
            Value(static_cast<double>(connId)),
            String::createFromUtf8(rt, "message"),
            std::move(v));
      } catch (...) {
      }
    }
  });
}

void ReactNativeWorkersImpl::deliverLog(
    uint32_t runtimeId,
    const std::string& level,
    const std::string& text) {
  postToHost([this, runtimeId, level, text](Runtime& rt) {
    auto it = runtimeConnections_.find(runtimeId);
    if (it == runtimeConnections_.end()) return;
    for (uint32_t connId : it->second) {
      Object o(rt);
      o.setProperty(rt, "level", String::createFromUtf8(rt, level));
      o.setProperty(rt, "text", String::createFromUtf8(rt, text));
      try {
        rt.global()
            .getPropertyAsFunction(rt, "__rnworkersDeliver")
            .call(
                rt,
                Value(static_cast<double>(connId)),
                String::createFromUtf8(rt, "log"),
                std::move(o));
      } catch (...) {
        // The host may be tearing down; a dropped log is never worth throwing.
      }
    }
  });
}

void ReactNativeWorkersImpl::deliverError(
    uint32_t runtimeId,
    WorkerError error) {
  postToHost([this, runtimeId, error](Runtime& rt) {
    auto it = runtimeConnections_.find(runtimeId);
    if (it == runtimeConnections_.end()) return;
    for (uint32_t connId : it->second) {
      Object o(rt);
      o.setProperty(rt, "message", String::createFromUtf8(rt, error.message));
      o.setProperty(rt, "filename", String::createFromUtf8(rt, error.filename));
      o.setProperty(rt, "lineno", Value(static_cast<double>(error.lineno)));
      o.setProperty(rt, "colno", Value(static_cast<double>(error.colno)));
      o.setProperty(rt, "stack", String::createFromUtf8(rt, error.stack));
      try {
        rt.global()
            .getPropertyAsFunction(rt, "__rnworkersDeliver")
            .call(
                rt,
                Value(static_cast<double>(connId)),
                String::createFromUtf8(rt, "error"),
                std::move(o));
      } catch (...) {
      }
    }
  });
}

void ReactNativeWorkersImpl::workerClosed(uint32_t runtimeId) {
  // self.close() from the worker. Reap the whole runtime (all its connections).
  postToHost([this, runtimeId](Runtime&) { reapRuntime(runtimeId); });
}

void ReactNativeWorkersImpl::enableDeviceEvents(uint32_t runtimeId) {
  // Called from the worker thread; hop to the host JS thread where the set and
  // the wrapped emitter live. Keyed by runtime — delivered once regardless of
  // how many connections are attached.
  postToHost(
      [this, runtimeId](Runtime&) { deviceEventRuntimes_.insert(runtimeId); });
}

} // namespace facebook::react
