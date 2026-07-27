#include "MessageCodec.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <optional>
#include <utility>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

enum Tag : uint8_t {
  TAG_UNDEFINED = 0,
  TAG_NULL = 1,
  TAG_FALSE = 2,
  TAG_TRUE = 3,
  TAG_INT32 = 4,
  TAG_DOUBLE = 5,
  TAG_STRING = 6,
  TAG_ARRAY = 7,
  TAG_OBJECT = 8,
  TAG_REF = 9,
  TAG_DATE = 10,
  TAG_ARRAYBUFFER = 11,
  TAG_TYPEDARRAY = 12,
  // A SharedBuffer passed BY REFERENCE: only its name travels, and the receiver
  // reopens the same native allocation. Nothing is copied, at any size.
  TAG_SHAREDBUFFER = 13,
  // A TRANSFERRED ArrayBuffer: an index into Message::transfers. The bytes never
  // move; the receiver wraps the sender's backing store.
  TAG_TRANSFER = 14,
};

class VecMutableBuffer : public MutableBuffer {
 public:
  explicit VecMutableBuffer(std::shared_ptr<std::vector<uint8_t>> v)
      : v_(std::move(v)) {}
  size_t size() const override { return v_->size(); }
  uint8_t* data() override { return v_->data(); }

 private:
  std::shared_ptr<std::vector<uint8_t>> v_;
};

// ---- encoder ----

// `Runtime::tryGetMutableBuffer` — the whole basis of zero-copy transfer — was
// added to JSI after our floor (RN 0.81), and Hermes ships almost no exported
// symbols, so there is nothing to probe at link time. Detect the METHOD at compile
// time instead: it is a virtual on the runtime we already hold, so where the
// header has it the call is an ordinary vtable dispatch, and where it doesn't the
// branch compiles away and transfers degrade to copies.
template <typename R, typename = void>
struct HasTryGetMutableBuffer : std::false_type {};
template <typename R>
struct HasTryGetMutableBuffer<
    R,
    std::void_t<decltype(std::declval<R&>().tryGetMutableBuffer(
        std::declval<const ArrayBuffer&>()))>> : std::true_type {};

constexpr bool kCanTransfer = HasTryGetMutableBuffer<Runtime>::value;

// Reaches an ArrayBuffer's backing store, or null when the engine won't share it.
std::shared_ptr<MutableBuffer> tryTakeBackingStore(
    Runtime& rt,
    const ArrayBuffer& ab) {
  if constexpr (HasTryGetMutableBuffer<Runtime>::value) {
    return rt.tryGetMutableBuffer(ab);
  } else {
    (void)rt;
    (void)ab;
    return nullptr;
  }
}

// Simulated detachment.
//
// The spec detaches a transferred ArrayBuffer: byteLength becomes 0 and access
// throws. JSI gives us no detach (Hermes has JSArrayBuffer::detach internally, but
// nothing public exposes it — `detached()` is query-only), so we cannot make the
// engine forget the buffer.
//
// What we CAN do is mark the object, since an ArrayBuffer is an ordinary JS object
// here. That buys the spec's *error* semantics — a transferred buffer can no longer
// be cloned or transferred again, which is where misuse actually shows up — and an
// honest `detached` getter. It does NOT make reads throw: code that keeps using a
// transferred buffer still sees live memory. That limit is documented rather than
// papered over.
constexpr const char* kTransferredProp = "__rnworkersTransferred";

bool isMarkedTransferred(Runtime& rt, const Object& obj) {
  Value v = obj.getProperty(rt, kTransferredProp);
  return v.isBool() && v.getBool();
}

void markTransferred(Runtime& rt, const Object& obj) {
  // defineProperty rather than setProperty: non-enumerable so it never surfaces in
  // user iteration, and non-configurable so it cannot be cleared to "re-attach".
  Object objectCtor = rt.global().getPropertyAsObject(rt, "Object");
  Function defineProperty = objectCtor.getPropertyAsFunction(rt, "defineProperty");
  Object descriptor(rt);
  descriptor.setProperty(rt, "value", Value(true));
  descriptor.setProperty(rt, "enumerable", Value(false));
  descriptor.setProperty(rt, "writable", Value(false));
  descriptor.setProperty(rt, "configurable", Value(false));
  defineProperty.call(
      rt,
      Value(rt, obj),
      String::createFromAscii(rt, kTransferredProp),
      std::move(descriptor));
}

// The buffers a postMessage asked to transfer, paired with the index they were
// given in Message::transfers. Small and linear on purpose: a transfer list is a
// handful of entries, and jsi has no hashable object identity.
struct TransferTable {
  // Held as Values because jsi::Object is move-only; Value is the copyable handle.
  std::vector<std::pair<Value, uint32_t>> entries;
  // Every buffer the caller asked to transfer, including ones the engine would
  // not give us a store for (those still encode by copy, but ownership moves).
  std::vector<Value> accepted;

  // Detach (as far as JSI allows) — only after the whole message has encoded, so
  // a throwing postMessage leaves the caller's buffers untouched.
  void markAllTransferred(Runtime& rt) const {
    for (const auto& obj : accepted) {
      markTransferred(rt, obj.getObject(rt));
    }
  }

  // Index for `ab` if it was transferred, else nullopt.
  std::optional<uint32_t> find(Runtime& rt, const Object& ab) const {
    for (const auto& [held, index] : entries) {
      if (held.isObject() && Object::strictEquals(rt, held.getObject(rt), ab)) {
        return index;
      }
    }
    return std::nullopt;
  }
};

struct Encoder {
  Runtime& rt;
  const TransferTable* transfers = nullptr;
  Message msg;
  // Cycle/dedup detection via a JS Map (object -> id): identity-hashed O(1)
  // lookup per object instead of a linear jsi strictEquals scan (O(N^2) over the
  // whole graph). All helpers are created lazily on the first object encountered
  // so primitive-only messages — the postMessage hot path — pay for none of it.
  std::optional<Object> seenMap;
  std::optional<Function> seenGet;
  std::optional<Function> seenSet;
  uint32_t seenCount = 0;
  std::optional<Function> dateCtor;
  std::optional<Function> isViewFn;

  explicit Encoder(Runtime& r) : rt(r) { msg.data.reserve(128); }

  void ensureHelpers() {
    if (seenMap) return;
    seenMap.emplace(rt.global()
                        .getPropertyAsFunction(rt, "Map")
                        .callAsConstructor(rt)
                        .getObject(rt));
    seenGet.emplace(seenMap->getPropertyAsFunction(rt, "get"));
    seenSet.emplace(seenMap->getPropertyAsFunction(rt, "set"));
    dateCtor.emplace(rt.global().getPropertyAsFunction(rt, "Date"));
    isViewFn.emplace(rt.global()
                         .getPropertyAsObject(rt, "ArrayBuffer")
                         .getPropertyAsFunction(rt, "isView"));
  }

  // Register a container in the identity map. Ids are assigned in encounter
  // order, matching the decoder's `decoded` vector.
  void remember(const Value& v) {
    seenSet->callWithThis(
        rt, *seenMap, v, Value(static_cast<double>(seenCount++)));
  }

  void byte(uint8_t b) { msg.data.push_back(b); }
  void varuint(uint32_t v) {
    while (v >= 0x80) {
      msg.data.push_back(static_cast<uint8_t>(v) | 0x80);
      v >>= 7;
    }
    msg.data.push_back(static_cast<uint8_t>(v));
  }
  void raw(const uint8_t* p, size_t n) { msg.data.insert(msg.data.end(), p, p + n); }
  void str(const std::string& s) {
    varuint(static_cast<uint32_t>(s.size()));
    raw(reinterpret_cast<const uint8_t*>(s.data()), s.size());
  }
  uint32_t addBlob(const uint8_t* p, size_t n) {
    msg.blobs.push_back(std::make_shared<std::vector<uint8_t>>(p, p + n));
    return static_cast<uint32_t>(msg.blobs.size() - 1);
  }
};

void encodeValue(Encoder& e, const Value& v);

void encodeObject(Encoder& e, const Value& v, const Object& obj) {
  Runtime& rt = e.rt;
  if (obj.isFunction(rt)) {
    throw DataCloneError("Could not clone value: a function cannot be cloned.");
  }
  e.ensureHelpers();
  {
    // Only arrays/objects are ever registered, so a hit is always a container.
    Value found = e.seenGet->callWithThis(rt, *e.seenMap, v);
    if (found.isNumber()) {
      e.byte(TAG_REF);
      e.varuint(static_cast<uint32_t>(found.getNumber()));
      return;
    }
  }

  // A SharedBuffer is already shared memory — copying its bytes into the message
  // would be pure waste, and would break the primitive's whole point by handing
  // the receiver a private copy. Send the name; the other side reopens the same
  // allocation through the process-global registry.
  {
    Value marker = obj.getProperty(rt, "__rnworkersSharedBufferName");
    if (marker.isString()) {
      e.byte(TAG_SHAREDBUFFER);
      e.str(marker.getString(rt).utf8(rt));
      double byteLength = 0;
      Value len = obj.getProperty(rt, "byteLength");
      if (len.isNumber()) byteLength = len.getNumber();
      e.varuint(static_cast<uint32_t>(byteLength));
      return;
    }
  }

  if (obj.isArrayBuffer(rt)) {
    // Structured-cloning a detached buffer is a DataCloneError per spec, and this
    // is where use-after-transfer realistically surfaces.
    if (isMarkedTransferred(rt, obj)) {
      throw DataCloneError(
          "Could not clone value: the ArrayBuffer has been transferred.");
    }
    // Listed for transfer AND reachable: hand over the backing store instead of
    // copying the bytes.
    if (e.transfers) {
      if (auto index = e.transfers->find(rt, obj)) {
        e.byte(TAG_TRANSFER);
        e.varuint(*index);
        return;
      }
    }
    ArrayBuffer ab = obj.getArrayBuffer(rt);
    e.byte(TAG_ARRAYBUFFER);
    e.varuint(e.addBlob(ab.data(rt), ab.size(rt)));
    return;
  }

  // Arrays before the isView JS call: arrays are common and never views.
  if (obj.isArray(rt)) {
    e.remember(v); // id = encounter order; registered before children
    Array arr = obj.getArray(rt);
    size_t n = arr.size(rt);
    e.byte(TAG_ARRAY);
    e.varuint(static_cast<uint32_t>(n));
    for (size_t i = 0; i < n; ++i) {
      encodeValue(e, arr.getValueAtIndex(rt, i));
    }
    return;
  }

  if (e.isViewFn->call(rt, Value(rt, v)).getBool()) {
    std::string ctorName = obj.getPropertyAsObject(rt, "constructor")
                               .getProperty(rt, "name")
                               .asString(rt)
                               .utf8(rt);
    size_t byteOffset =
        static_cast<size_t>(obj.getProperty(rt, "byteOffset").asNumber());
    size_t byteLength =
        static_cast<size_t>(obj.getProperty(rt, "byteLength").asNumber());
    ArrayBuffer ab = obj.getPropertyAsObject(rt, "buffer").getArrayBuffer(rt);
    e.byte(TAG_TYPEDARRAY);
    e.str(ctorName);
    e.varuint(e.addBlob(ab.data(rt) + byteOffset, byteLength));
    return;
  }

  if (obj.instanceOf(rt, *e.dateCtor)) {
    double t = obj.getPropertyAsFunction(rt, "getTime")
                   .callWithThis(rt, obj)
                   .asNumber();
    e.byte(TAG_DATE);
    uint8_t buf[8];
    std::memcpy(buf, &t, 8);
    e.raw(buf, 8);
    return;
  }

  e.remember(v);
  Array names = obj.getPropertyNames(rt);
  size_t n = names.size(rt);
  e.byte(TAG_OBJECT);
  e.varuint(static_cast<uint32_t>(n));
  for (size_t i = 0; i < n; ++i) {
    // Keep the jsi::String: the property lookup uses it directly instead of
    // round-tripping through utf8 -> char* -> a new interned name.
    String nameStr = names.getValueAtIndex(rt, i).asString(rt);
    e.str(nameStr.utf8(rt));
    encodeValue(e, obj.getProperty(rt, nameStr));
  }
}

void encodeValue(Encoder& e, const Value& v) {
  Runtime& rt = e.rt;
  if (v.isUndefined()) {
    e.byte(TAG_UNDEFINED);
  } else if (v.isNull()) {
    e.byte(TAG_NULL);
  } else if (v.isBool()) {
    e.byte(v.getBool() ? TAG_TRUE : TAG_FALSE);
  } else if (v.isNumber()) {
    double d = v.getNumber();
    // Compact path for integers that are not -0.
    if (d >= -2147483648.0 && d <= 2147483647.0 &&
        d == static_cast<double>(static_cast<int32_t>(d)) &&
        !(d == 0.0 && std::signbit(d))) {
      e.byte(TAG_INT32);
      int32_t i = static_cast<int32_t>(d);
      uint8_t buf[4];
      std::memcpy(buf, &i, 4);
      e.raw(buf, 4);
    } else {
      e.byte(TAG_DOUBLE);
      uint8_t buf[8];
      std::memcpy(buf, &d, 8);
      e.raw(buf, 8);
    }
  } else if (v.isString()) {
    e.byte(TAG_STRING);
    e.str(v.getString(rt).utf8(rt));
  } else if (v.isSymbol()) {
    throw DataCloneError("Could not clone value: a symbol cannot be cloned.");
  } else if (v.isBigInt()) {
    throw DataCloneError("Could not clone value: BigInt is not yet supported.");
  } else if (v.isObject()) {
    Object obj = v.getObject(rt);
    encodeObject(e, v, obj);
  } else {
    e.byte(TAG_UNDEFINED);
  }
}

// ---- decoder ----

struct Decoder {
  Runtime& rt;
  const Message& msg;
  size_t off = 0;
  std::vector<Value> decoded; // arrays/objects in creation order (for refs)

  Decoder(Runtime& r, const Message& m) : rt(r), msg(m) {}

  uint8_t byte() {
    if (off >= msg.data.size()) throw DataCloneError("message truncated");
    return msg.data[off++];
  }
  uint32_t varuint() {
    uint32_t result = 0;
    // Bounded: a uint32 needs at most 5 varint bytes; more is a malformed
    // message (and an unbounded shift would be UB).
    for (int shift = 0; shift <= 28; shift += 7) {
      uint8_t b = byte();
      result |= static_cast<uint32_t>(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
    }
    throw DataCloneError("message truncated");
  }
  // Bounds-checked view into the wire bytes (overflow-safe: off <= size).
  const uint8_t* bytes(size_t n) {
    if (n > msg.data.size() - off) throw DataCloneError("message truncated");
    const uint8_t* p = msg.data.data() + off;
    off += n;
    return p;
  }
  void raw(void* dst, size_t n) { std::memcpy(dst, bytes(n), n); }
  std::string str() {
    uint32_t n = varuint();
    return std::string(reinterpret_cast<const char*>(bytes(n)), n);
  }
  std::shared_ptr<std::vector<uint8_t>> blob(uint32_t idx) {
    if (idx >= msg.blobs.size()) throw DataCloneError("bad blob index");
    return msg.blobs[idx];
  }
};

Value decodeValue(Decoder& d) {
  Runtime& rt = d.rt;
  uint8_t tag = d.byte();
  switch (tag) {
    case TAG_UNDEFINED:
      return Value::undefined();
    case TAG_NULL:
      return Value::null();
    case TAG_FALSE:
      return Value(false);
    case TAG_TRUE:
      return Value(true);
    case TAG_INT32: {
      int32_t i;
      d.raw(&i, 4);
      return Value(static_cast<double>(i));
    }
    case TAG_DOUBLE: {
      double x;
      d.raw(&x, 8);
      return Value(x);
    }
    case TAG_STRING: {
      // Build the jsi string straight from the wire bytes — no std::string.
      uint32_t n = d.varuint();
      return Value(String::createFromUtf8(rt, d.bytes(n), n));
    }
    case TAG_DATE: {
      double t;
      d.raw(&t, 8);
      return rt.global()
          .getPropertyAsFunction(rt, "Date")
          .callAsConstructor(rt, Value(t));
    }
    case TAG_ARRAYBUFFER: {
      auto buf = std::make_shared<VecMutableBuffer>(d.blob(d.varuint()));
      return Value(ArrayBuffer(rt, buf));
    }
    case TAG_TYPEDARRAY: {
      std::string ctorName = d.str();
      auto buf = std::make_shared<VecMutableBuffer>(d.blob(d.varuint()));
      ArrayBuffer ab(rt, buf);
      return rt.global()
          .getPropertyAsFunction(rt, ctorName.c_str())
          .callAsConstructor(rt, std::move(ab));
    }
    case TAG_TRANSFER: {
      uint32_t idx = d.varuint();
      if (idx >= d.msg.transfers.size()) throw DataCloneError("bad transfer index");
      // The sender's own memory, wrapped in an ArrayBuffer belonging to THIS
      // runtime. No copy — both sides now view one allocation.
      return Value(ArrayBuffer(rt, d.msg.transfers[idx]));
    }
    case TAG_SHAREDBUFFER: {
      std::string name = d.str();
      uint32_t byteLength = d.varuint();
      // Rebuild a real SharedBuffer where the constructor exists (worker prelude
      // and, on the host, the class installed by src/SharedBuffer.native.ts), so
      // the receiver gets the same API it would have constructing it itself —
      // including withLock. Both paths open the SAME memory.
      Value ctor = rt.global().getProperty(rt, "SharedBuffer");
      if (ctor.isObject() && ctor.asObject(rt).isFunction(rt)) {
        return ctor.asObject(rt).asFunction(rt).callAsConstructor(
            rt,
            String::createFromUtf8(rt, name),
            Value(static_cast<double>(byteLength)));
      }
      // No constructor in this runtime: hand back the shared memory itself
      // rather than failing the whole message.
      Value opener = rt.global().getProperty(rt, "__rnworkersOpenSharedBuffer");
      if (opener.isObject() && opener.asObject(rt).isFunction(rt)) {
        return opener.asObject(rt).asFunction(rt).call(
            rt,
            String::createFromUtf8(rt, name),
            Value(static_cast<double>(byteLength)));
      }
      throw DataCloneError("SharedBuffer is not available in this runtime");
    }
    case TAG_REF: {
      uint32_t id = d.varuint();
      if (id >= d.decoded.size()) throw DataCloneError("bad ref");
      return Value(rt, d.decoded[id]);
    }
    case TAG_ARRAY: {
      uint32_t n = d.varuint();
      Value v{Array(rt, n)};
      d.decoded.emplace_back(Value(rt, v));
      Array arr = v.getObject(rt).getArray(rt);
      for (uint32_t i = 0; i < n; ++i) {
        arr.setValueAtIndex(rt, i, decodeValue(d));
      }
      return v;
    }
    case TAG_OBJECT: {
      uint32_t n = d.varuint();
      Value v{Object(rt)};
      d.decoded.emplace_back(Value(rt, v));
      Object obj = v.getObject(rt);
      for (uint32_t i = 0; i < n; ++i) {
        // Sequenced explicitly: the key bytes must be consumed before the value
        // decode advances the cursor (argument evaluation order is unspecified).
        uint32_t kn = d.varuint();
        String key = String::createFromUtf8(rt, d.bytes(kn), kn);
        Value val = decodeValue(d);
        obj.setProperty(rt, key, std::move(val));
      }
      return v;
    }
    default:
      throw DataCloneError("unknown message tag");
  }
}

// ---- JSON projection (native bridge; no runtime) ----

void jsonEscape(const std::string& s, std::string& out) {
  out.push_back('"');
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char b[8];
          std::snprintf(b, sizeof(b), "\\u%04x", c);
          out += b;
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('"');
}

struct JsonReader {
  const Message& msg;
  size_t off = 0;
  uint8_t byte() { return off < msg.data.size() ? msg.data[off++] : TAG_NULL; }
  uint32_t varuint() {
    uint32_t r = 0;
    // Bounded like Decoder::varuint; this reader is tolerant, so just stop.
    for (int s = 0; s <= 28; s += 7) {
      uint8_t b = byte();
      r |= static_cast<uint32_t>(b & 0x7f) << s;
      if (!(b & 0x80)) break;
    }
    return r;
  }
  std::string str() {
    uint32_t n = varuint();
    size_t avail = msg.data.size() - off;
    size_t take = n < avail ? n : avail;
    std::string out(reinterpret_cast<const char*>(msg.data.data() + off), take);
    off += take;
    return out;
  }
  template <typename T>
  T read() {
    T v{};
    if (off + sizeof(T) <= msg.data.size()) {
      std::memcpy(&v, msg.data.data() + off, sizeof(T));
      off += sizeof(T);
    }
    return v;
  }
};

void writeJson(JsonReader& r, std::string& out) {
  uint8_t tag = r.byte();
  switch (tag) {
    case TAG_UNDEFINED:
    case TAG_NULL:
    case TAG_REF:
    case TAG_ARRAYBUFFER:
    case TAG_TYPEDARRAY:
    case TAG_TRANSFER:
    case TAG_SHAREDBUFFER:
      // Binary has no JSON form, but every payload must still be CONSUMED here:
      // this reader walks the same byte stream as the decoder, so skipping a
      // field would mis-parse everything after it.
      if (tag == TAG_REF || tag == TAG_ARRAYBUFFER || tag == TAG_TRANSFER) {
        r.varuint();
      }
      if (tag == TAG_TYPEDARRAY) { r.str(); r.varuint(); }
      if (tag == TAG_SHAREDBUFFER) { r.str(); r.varuint(); }
      out += "null";
      break;
    case TAG_FALSE: out += "false"; break;
    case TAG_TRUE: out += "true"; break;
    case TAG_INT32: {
      int32_t i = r.read<int32_t>();
      out += std::to_string(i);
      break;
    }
    case TAG_DOUBLE:
    case TAG_DATE: {
      double x = r.read<double>();
      if (std::isfinite(x)) {
        char b[32];
        std::snprintf(b, sizeof(b), "%.17g", x);
        out += b;
      } else {
        out += "null";
      }
      break;
    }
    case TAG_STRING:
      jsonEscape(r.str(), out);
      break;
    case TAG_ARRAY: {
      uint32_t n = r.varuint();
      out.push_back('[');
      for (uint32_t i = 0; i < n; ++i) {
        if (i) out.push_back(',');
        writeJson(r, out);
      }
      out.push_back(']');
      break;
    }
    case TAG_OBJECT: {
      uint32_t n = r.varuint();
      out.push_back('{');
      for (uint32_t i = 0; i < n; ++i) {
        if (i) out.push_back(',');
        jsonEscape(r.str(), out);
        out.push_back(':');
        writeJson(r, out);
      }
      out.push_back('}');
      break;
    }
    default:
      out += "null";
  }
}

} // namespace

bool supportsZeroCopyTransfer() {
  return kCanTransfer;
}

// Builds the transfer table: for each ArrayBuffer in the list, take its backing
// store. Entries we cannot take are simply left out, so they encode as ordinary
// (copied) buffers — a transfer list must never make a message fail.
static TransferTable buildTransferTable(
    Runtime& rt,
    const Value& transferList,
    Message& msg) {
  TransferTable table;
  if (transferList.isUndefined() || transferList.isNull()) return table;
  if (!transferList.isObject()) return table;
  Object listObj = transferList.getObject(rt);
  if (!listObj.isArray(rt)) return table;
  Array list = listObj.getArray(rt);
  size_t n = list.size(rt);

  for (size_t i = 0; i < n; ++i) {
    Value item = list.getValueAtIndex(rt, i);
    // Spec: a non-transferable entry is a DataCloneError. ArrayBuffer is the only
    // transferable type here (no MessagePort/ImageBitmap in this runtime).
    if (!item.isObject() || !item.getObject(rt).isArrayBuffer(rt)) {
      throw DataCloneError(
          "Failed to execute 'postMessage': the transfer list contains a value "
          "that is not a transferable object.");
    }
    Object obj = item.getObject(rt);
    if (isMarkedTransferred(rt, obj)) {
      throw DataCloneError(
          "Failed to execute 'postMessage': an ArrayBuffer in the transfer list "
          "has already been transferred.");
    }
    // Spec: the same object twice in one transfer list is a DataCloneError.
    for (const auto& seen : table.accepted) {
      if (Object::strictEquals(rt, seen.getObject(rt), obj)) {
        throw DataCloneError(
            "Failed to execute 'postMessage': an ArrayBuffer appears twice in "
            "the transfer list.");
      }
    }

    auto store = tryTakeBackingStore(rt, obj.getArrayBuffer(rt));
    if (store) {
      // Zero-copy: the receiver wraps this very allocation.
      msg.transfers.push_back(std::move(store));
      table.entries.emplace_back(
          Value(rt, obj), static_cast<uint32_t>(msg.transfers.size() - 1));
    }
    // No store (an engine-internal ArrayBuffer — Hermes only shares `external()`
    // ones): it still encodes, by copy. The caller asked to transfer, so it is
    // still marked below; ownership semantics stay the same either way.
    table.accepted.emplace_back(rt, obj);
  }
  return table;
}

Message encode(Runtime& rt, const Value& value, const Value& transferList) {
  Encoder e(rt);
  TransferTable table = buildTransferTable(rt, transferList, e.msg);
  e.transfers = &table;
  encodeValue(e, value);
  // Encoding succeeded, so the handover is real: detach the sources now. Doing it
  // earlier would make the encoder reject the very buffers being transferred (they
  // are normally part of the message body too), and would strand the caller's
  // buffers as detached if encoding threw.
  table.markAllTransferred(rt);
  return std::move(e.msg);
}

Message encode(Runtime& rt, const Value& value) {
  Encoder e(rt);
  encodeValue(e, value);
  return std::move(e.msg);
}

Value decode(Runtime& rt, const Message& message) {
  Decoder d(rt, message);
  return decodeValue(d);
}

std::string messageToJson(const Message& message) {
  JsonReader r{message};
  std::string out;
  writeJson(r, out);
  return out;
}

} // namespace facebook::react::workers
