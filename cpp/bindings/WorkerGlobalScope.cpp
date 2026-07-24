#include "WorkerGlobalScope.h"

#include "../core/MessageCodec.h"

#include <memory>
#include <utility>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

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

std::string optString(Runtime& rt, const Value& v) {
  return v.isString() ? v.getString(rt).utf8(rt) : std::string();
}

int optInt(const Value& v) {
  return v.isNumber() ? static_cast<int>(v.getNumber()) : 0;
}

} // namespace

void installWorkerGlobalScope(Runtime& rt, WorkerHooks hooks) {
  auto shared = std::make_shared<WorkerHooks>(std::move(hooks));

  rt.global().setProperty(
      rt,
      "__rnworkersSourceURL",
      String::createFromUtf8(rt, shared->sourceUrl));

  setHostFn(
      rt,
      "__workerPostMessage",
      2,
      [shared](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        if (count < 1) return Value::undefined();
        try {
          Message msg = encode(rt, args[0]);
          if (shared->onPostMessage) shared->onPostMessage(std::move(msg));
        } catch (const DataCloneError& e) {
          throw JSError(rt, e.what());
        }
        return Value::undefined();
      });

  setHostFn(
      rt,
      "__workerClose",
      0,
      [shared](Runtime&, const Value&, const Value*, size_t) -> Value {
        if (shared->onClose) shared->onClose();
        return Value::undefined();
      });

  setHostFn(
      rt,
      "__workerLog",
      2,
      [shared](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        std::string level = count > 0 ? optString(rt, args[0]) : "log";
        std::string text = count > 1 ? optString(rt, args[1]) : "";
        if (shared->onLog) shared->onLog(level, text);
        return Value::undefined();
      });

  setHostFn(
      rt,
      "__workerReportError",
      5,
      [shared](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        WorkerError err;
        err.message = count > 0 ? optString(rt, args[0]) : "";
        err.filename = count > 1 ? optString(rt, args[1]) : "";
        err.lineno = count > 2 ? optInt(args[2]) : 0;
        err.colno = count > 3 ? optInt(args[3]) : 0;
        err.stack = count > 4 ? optString(rt, args[4]) : "";
        if (shared->onReportError) shared->onReportError(std::move(err));
        return Value::undefined();
      });

  setHostFn(
      rt,
      "__workerSetTimer",
      3,
      [shared](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        if (count < 1 || !args[0].isObject() ||
            !args[0].getObject(rt).isFunction(rt)) {
          return Value(0.0);
        }
        auto cb = std::make_shared<Function>(
            args[0].getObject(rt).getFunction(rt));
        double ms = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
        bool repeat = count > 2 && args[2].isBool() && args[2].getBool();
        uint32_t id = 0;
        if (shared->onSetTimer) id = shared->onSetTimer(cb, ms, repeat);
        return Value(static_cast<double>(id));
      });

  setHostFn(
      rt,
      "__workerClearTimer",
      1,
      [shared](Runtime& rt, const Value&, const Value* args, size_t count)
          -> Value {
        if (count > 0 && args[0].isNumber() && shared->onClearTimer) {
          shared->onClearTimer(static_cast<uint32_t>(args[0].getNumber()));
        }
        return Value::undefined();
      });

  setHostFn(
      rt,
      "__workerEnableDeviceEvents",
      0,
      [shared](Runtime&, const Value&, const Value*, size_t) -> Value {
        if (shared->onEnableDeviceEvents) shared->onEnableDeviceEvents();
        return Value::undefined();
      });

  installStructuredClone(rt);
}

void installStructuredClone(Runtime& rt) {
  setHostFn(
      rt,
      "structuredClone",
      1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "structuredClone requires 1 argument");
        }
        try {
          return decode(rt, encode(rt, args[0]));
        } catch (const DataCloneError& e) {
          throw JSError(rt, e.what());
        }
      });
}

} // namespace facebook::react::workers
