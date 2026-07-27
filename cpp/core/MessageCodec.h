#pragma once

#include <jsi/jsi.h>

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace facebook::react::workers {

// Thrown when a value cannot be structured-cloned (functions, symbols, etc.).
class DataCloneError : public std::runtime_error {
 public:
  explicit DataCloneError(const std::string& what) : std::runtime_error(what) {}
};

// A serialized message: a flat little-endian byte buffer, plus out-of-band
// binary "blobs" referenced by index. Structured data (objects/arrays/strings/
// numbers) lives in `data` with one contiguous allocation; binary payloads
// (ArrayBuffer/TypedArray) live in `blobs` so they are copied at most once on
// encode and shared zero-copy on decode. Host and worker share a process +
// architecture, so encoding is native-endian (no byte-swapping).
struct Message {
  std::vector<uint8_t> data;
  std::vector<std::shared_ptr<std::vector<uint8_t>>> blobs;
  // TRANSFERRED buffers: the sender's own backing store, handed over rather than
  // copied. The receiver wraps each one in an ArrayBuffer of its own runtime, so
  // both sides end up viewing one allocation and nothing is copied at any size.
  std::vector<std::shared_ptr<jsi::MutableBuffer>> transfers;
};

// Encode a value from `rt`. Throws DataCloneError on unsupported types.
Message encode(jsi::Runtime& rt, const jsi::Value& value);

// As above, with a `postMessage` transfer list: every ArrayBuffer in `transferList`
// that the engine lets us reach the backing store of travels by reference instead
// of being copied.
//
// Buffers whose store is NOT reachable (an engine-allocated ArrayBuffer on a JSI
// without `tryGetMutableBuffer`, or a Hermes buffer it declines) fall back to a
// copy — the message still arrives intact, it just isn't free.
Message encode(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const jsi::Value& transferList);

// Whether this build can transfer buffers without copying (i.e. the JSI it was
// compiled against exposes `tryGetMutableBuffer`). Reported to JS for diagnostics
// and used by the tests to assert the right behaviour per RN version.
bool supportsZeroCopyTransfer();

// Rehydrate a message into `rt`.
jsi::Value decode(jsi::Runtime& rt, const Message& message);

// Convert a message to a JSON string (for the native worker bridge). Binary and
// back-references become null; used where no jsi::Runtime is available.
std::string messageToJson(const Message& message);

} // namespace facebook::react::workers
