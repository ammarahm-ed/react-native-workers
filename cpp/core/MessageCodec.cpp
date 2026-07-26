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

struct Encoder {
  Runtime& rt;
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

  if (obj.isArrayBuffer(rt)) {
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
      if (tag == TAG_REF || tag == TAG_ARRAYBUFFER) r.varuint();
      if (tag == TAG_TYPEDARRAY) { r.str(); r.varuint(); }
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
