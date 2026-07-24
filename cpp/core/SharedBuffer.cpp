#include "SharedBuffer.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

// A MutableBuffer over shared native bytes. The SAME instance backs every
// runtime's ArrayBuffer for a given name, so they all point at one allocation.
class SharedMem : public MutableBuffer {
 public:
  explicit SharedMem(std::shared_ptr<std::vector<uint8_t>> bytes)
      : bytes_(std::move(bytes)) {}
  size_t size() const override {
    return bytes_->size();
  }
  uint8_t* data() override {
    return bytes_->data();
  }

  // The buffer's cross-runtime lock lives HERE rather than in its own registry,
  // so it shares the memory's identity and lifetime exactly. Keeping it separate
  // would let a moment with no live LockHandle hand the next opener a brand-new
  // mutex while another runtime still holds the old one — two "locks" for one
  // buffer, mutually excluding nothing.
  std::recursive_mutex mutex;

 private:
  std::shared_ptr<std::vector<uint8_t>> bytes_;
};

std::mutex& registryMutex() {
  static std::mutex m;
  return m;
}
// WEAK registry — see the explanation in SharedValue.cpp. Here the owner is the
// jsi::ArrayBuffer itself: it holds the SharedMem shared_ptr, so the memory lives
// as long as ANY runtime still has a view over it and is freed when the last one
// is collected. This is the primitive where it matters most — buffers are the
// large allocations, so a per-frame or per-document name would otherwise pin
// megabytes for the life of the process.
std::unordered_map<std::string, std::weak_ptr<SharedMem>>& bufferRegistry() {
  static std::unordered_map<std::string, std::weak_ptr<SharedMem>> r;
  return r;
}

void sweepExpiredLocked(
    std::unordered_map<std::string, std::weak_ptr<SharedMem>>& r) {
  if (r.size() < 32) return;
  for (auto it = r.begin(); it != r.end();) {
    if (it->second.expired()) it = r.erase(it);
    else ++it;
  }
}

std::shared_ptr<SharedMem> openBuffer(const std::string& name, size_t byteLength) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = bufferRegistry();
  auto it = r.find(name);
  if (it != r.end()) {
    // First LIVE opener fixes the size; once the memory is gone the name is free
    // to be re-created at a different length.
    if (auto alive = it->second.lock()) return alive;
  }
  sweepExpiredLocked(r);
  auto mem = std::make_shared<SharedMem>(
      std::make_shared<std::vector<uint8_t>>(byteLength, 0));
  r[name] = mem;
  return mem;
}


// Cross-runtime named locks. Recursive so a `withLock` body may re-enter on the
// same thread; still mutually excludes across threads/runtimes.
//
// A lock for a name with a live buffer IS that buffer's mutex, handed out via the
// aliasing constructor: the returned shared_ptr points at `mem->mutex` while
// owning `mem`, so holding a lock also keeps the memory alive and every runtime
// provably gets the same mutex. Standalone locks (a name with no buffer) fall
// back to their own weak registry.
std::unordered_map<std::string, std::weak_ptr<std::recursive_mutex>>&
lockRegistry() {
  static std::unordered_map<std::string, std::weak_ptr<std::recursive_mutex>> r;
  return r;
}
std::shared_ptr<std::recursive_mutex> openLock(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& bufs = bufferRegistry();
  auto bit = bufs.find(name);
  if (bit != bufs.end()) {
    if (auto mem = bit->second.lock()) {
      return std::shared_ptr<std::recursive_mutex>(mem, &mem->mutex);
    }
  }
  auto& r = lockRegistry();
  auto it = r.find(name);
  if (it != r.end()) {
    if (auto alive = it->second.lock()) return alive;
  }
  auto m = std::make_shared<std::recursive_mutex>();
  r[name] = m;
  return m;
}

// Force the name to be forgotten now, before its owners have let go — see
// releaseCell in SharedValue.cpp. Refcounting handles cleanup on its own; this
// just orphans the name so the next open allocates fresh memory (at whatever
// length that opener asks for). Views already handed out stay valid but no longer
// alias what the name resolves to afterwards. Returns whether the name was live.
bool releaseBuffer(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = bufferRegistry();
  bool wasLive = false;
  auto it = r.find(name);
  if (it != r.end()) {
    wasLive = !it->second.expired();
    r.erase(it);
  }
  lockRegistry().erase(name);
  return wasLive;
}

class LockHandle : public HostObject {
 public:
  explicit LockHandle(std::shared_ptr<std::recursive_mutex> mtx)
      : mtx_(std::move(mtx)) {}

  Value get(Runtime& rt, const PropNameID& name) override {
    std::string prop = name.utf8(rt);
    auto mtx = mtx_;
    if (prop == "withLock") {
      // Hold the lock across a JS callback (RAII unlocks even if it throws).
      return Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "withLock"),
          1,
          [mtx](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 1 || !args[0].isObject() ||
                !args[0].getObject(rt).isFunction(rt))
              throw JSError(rt, "withLock(fn) requires a function");
            Function fn = args[0].getObject(rt).getFunction(rt);
            std::lock_guard<std::recursive_mutex> guard(*mtx);
            return fn.call(rt);
          });
    }
    if (prop == "lock") {
      return Function::createFromHostFunction(
          rt, PropNameID::forAscii(rt, "lock"), 0,
          [mtx](Runtime&, const Value&, const Value*, size_t) -> Value {
            mtx->lock();
            return Value::undefined();
          });
    }
    if (prop == "unlock") {
      return Function::createFromHostFunction(
          rt, PropNameID::forAscii(rt, "unlock"), 0,
          [mtx](Runtime&, const Value&, const Value*, size_t) -> Value {
            mtx->unlock();
            return Value::undefined();
          });
    }
    return Value::undefined();
  }

 private:
  std::shared_ptr<std::recursive_mutex> mtx_;
};

} // namespace

void installSharedBuffer(Runtime& rt) {
  rt.global().setProperty(
      rt,
      "__rnworkersOpenSharedBuffer",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersOpenSharedBuffer"),
          2,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 2 || !args[0].isString() || !args[1].isNumber())
              throw JSError(
                  rt, "openSharedBuffer(name, byteLength) requires (string, number)");
            std::string name = args[0].getString(rt).utf8(rt);
            auto len = static_cast<size_t>(args[1].getNumber());
            auto mem = openBuffer(name, len);
            // A fresh ArrayBuffer for THIS runtime over the shared native memory.
            return Value(ArrayBuffer(rt, mem));
          }));

  rt.global().setProperty(
      rt,
      "__rnworkersOpenSharedLock",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersOpenSharedLock"),
          1,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            std::string name =
                count > 0 && args[0].isString() ? args[0].getString(rt).utf8(rt)
                                                : std::string("default");
            return Value(Object::createFromHostObject(
                rt, std::make_shared<LockHandle>(openLock(name))));
          }));

  rt.global().setProperty(
      rt,
      "__rnworkersDeleteSharedBuffer",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersDeleteSharedBuffer"),
          1,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 1 || !args[0].isString())
              throw JSError(rt, "SharedBuffer.delete(name) requires a string");
            return Value(releaseBuffer(args[0].getString(rt).utf8(rt)));
          }));
}

} // namespace facebook::react::workers
