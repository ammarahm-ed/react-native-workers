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
};

// Encode a value from `rt`. Throws DataCloneError on unsupported types.
Message encode(jsi::Runtime& rt, const jsi::Value& value);

// Rehydrate a message into `rt`.
jsi::Value decode(jsi::Runtime& rt, const Message& message);

// Convert a message to a JSON string (for the native worker bridge). Binary and
// back-references become null; used where no jsi::Runtime is available.
std::string messageToJson(const Message& message);

} // namespace facebook::react::workers
