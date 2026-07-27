#include "WorkerGlobalScope.h"

#include "../core/MessageCodec.h"

#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

// Backing store for createTransferableBuffer: an ArrayBuffer built over one of
// these is `external()`, which is the only kind Hermes will hand back for a
// zero-copy transfer.
class VecBuffer : public MutableBuffer {
 public:
  explicit VecBuffer(std::shared_ptr<std::vector<uint8_t>> v)
      : v_(std::move(v)) {}
  size_t size() const override { return v_->size(); }
  uint8_t* data() override { return v_->data(); }

 private:
  std::shared_ptr<std::vector<uint8_t>> v_;
};

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
          // arg 1 is the transfer list (the prelude always passes an array).
          Message msg = count >= 2 ? encode(rt, args[0], args[1])
                                   : encode(rt, args[0]);
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
  // An ArrayBuffer whose backing store WE own.
  //
  // Hermes only lets a store be taken from an `external()` ArrayBuffer — one
  // created through `createArrayBuffer(MutableBuffer)` (hermes.cpp: it returns
  // nullptr for engine-internal buffers). A plain `new ArrayBuffer(n)` is
  // internal, so transferring it has to copy on the first hop.
  //
  // Buffers from here are external, so they transfer with no copy at every hop,
  // in both directions. Same API as an ordinary ArrayBuffer otherwise.
  setHostFn(
      rt,
      "createTransferableBuffer",
      1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isNumber()) {
          throw JSError(rt, "createTransferableBuffer(byteLength) requires a number");
        }
        double len = args[0].getNumber();
        if (len < 0 || len != len) {
          throw JSError(rt, "createTransferableBuffer: byteLength must be >= 0");
        }
        auto bytes = std::make_shared<std::vector<uint8_t>>(
            static_cast<size_t>(len), 0);
        auto store = std::make_shared<VecBuffer>(bytes);
        // Remember the store and stamp its id on the object, so transferring this
        // buffer needs nothing from the engine — that is what makes zero-copy
        // transfer work on every supported RN, not only those whose JSI has
        // tryGetMutableBuffer.
        double id = registerTransferableStore(store);
        Object ab = ArrayBuffer(rt, std::move(store));
        Object objectCtor = rt.global().getPropertyAsObject(rt, "Object");
        Function defineProperty =
            objectCtor.getPropertyAsFunction(rt, "defineProperty");
        Object descriptor(rt);
        descriptor.setProperty(rt, "value", Value(id));
        descriptor.setProperty(rt, "enumerable", Value(false));
        descriptor.setProperty(rt, "writable", Value(false));
        descriptor.setProperty(rt, "configurable", Value(false));
        defineProperty.call(
            rt,
            Value(rt, ab),
            String::createFromAscii(rt, kTransferableIdProp),
            std::move(descriptor));
        return Value(std::move(ab));
      });

  // Whether THIS build can transfer a foreign buffer without copying, i.e.
  // whether the JSI it compiled against has tryGetMutableBuffer (RN 0.86+).
  //
  // Exposed because otherwise a silent copy is indistinguishable from a real
  // transfer from JS: the header claimed tests used this, and nothing did.
  // Buffers from createTransferableBuffer are zero-copy regardless — their store
  // comes from our own registry — so this only describes the foreign-buffer case.
  rt.global().setProperty(
      rt,
      "__rnworkersZeroCopyTransfer",
      Value(supportsZeroCopyTransfer()));

  // `ArrayBuffer.prototype.detached` is a real spec getter, and the only part of
  // detachment we can honour: transfer marks the buffer (MessageCodec.cpp) and
  // this reports it. Reads are NOT blocked — the engine still sees live memory —
  // so this is an honest signal, not enforcement. Never shadow a real
  // implementation if the engine grows one.
  {
    Object arrayBufferCtor = rt.global().getPropertyAsObject(rt, "ArrayBuffer");
    Object proto = arrayBufferCtor.getPropertyAsObject(rt, "prototype");
    Object objectCtor = rt.global().getPropertyAsObject(rt, "Object");
    Function getOwn =
        objectCtor.getPropertyAsFunction(rt, "getOwnPropertyDescriptor");
    Value existing = getOwn.call(
        rt, Value(rt, proto), String::createFromAscii(rt, "detached"));
    // Newer Hermes defines this getter natively (arrayBufferPrototypeDetached).
    // Compose with it rather than skipping: the engine answers whether the buffer
    // is REALLY detached, we answer whether it was transferred through us. Skipping
    // would silently drop our signal the day RN ships that Hermes; shadowing would
    // hide a true detachment. Either alone is a wrong answer.
    std::shared_ptr<Function> nativeGetter;
    if (existing.isObject()) {
      Value g = existing.getObject(rt).getProperty(rt, "get");
      if (g.isObject() && g.asObject(rt).isFunction(rt)) {
        nativeGetter =
            std::make_shared<Function>(g.asObject(rt).asFunction(rt));
      }
    }
    {
      Function defineProperty =
          objectCtor.getPropertyAsFunction(rt, "defineProperty");
      Object descriptor(rt);
      descriptor.setProperty(
          rt,
          "get",
          Function::createFromHostFunction(
              rt,
              PropNameID::forAscii(rt, "detached"),
              0,
              [nativeGetter](
                  Runtime& rt, const Value& thisVal, const Value*, size_t)
                  -> Value {
                if (!thisVal.isObject()) return Value(false);
                Object self = thisVal.getObject(rt);
                if (nativeGetter) {
                  Value engineSaysDetached = nativeGetter->callWithThis(rt, self);
                  if (engineSaysDetached.isBool() && engineSaysDetached.getBool()) {
                    return Value(true);
                  }
                }
                Value marked = self.getProperty(rt, "__rnworkersTransferred");
                return Value(marked.isBool() && marked.getBool());
              }));
      descriptor.setProperty(rt, "configurable", Value(true));
      defineProperty.call(
          rt,
          Value(rt, proto),
          String::createFromAscii(rt, "detached"),
          std::move(descriptor));
    }
  }

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
