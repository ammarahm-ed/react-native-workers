#include "SharedValue.h"

#include "MessageCodec.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

struct SVSubscriber {
  uint64_t id;
  RuntimePoster poster;
  std::shared_ptr<Function> callback; // touched only on its own runtime thread
  std::shared_ptr<std::atomic<bool>> alive;
};

// A single shared cell. Numbers live in a lock-free atomic (the hot path);
// anything else is an encoded Message under `mutex`. `mode`: 0 = number,
// 1 = message, 2 = undefined. `hasSubs` lets a no-subscriber write stay fully
// lock-free (no need to touch the subscriber list).
struct SVCell {
  std::atomic<double> num{0};
  std::atomic<int> mode{2};
  std::atomic<bool> hasSubs{false};
  std::mutex mutex;
  std::shared_ptr<const Message> msg;
  std::vector<std::shared_ptr<SVSubscriber>> subs;
  uint64_t nextSubId = 1;

  Value read(Runtime& rt) {
    int m = mode.load(std::memory_order_acquire);
    if (m == 0) return Value(num.load(std::memory_order_relaxed));
    if (m == 2) return Value::undefined();
    std::shared_ptr<const Message> mm;
    {
      std::lock_guard<std::mutex> lock(mutex);
      mm = msg;
    }
    return mm ? decode(rt, *mm) : Value::undefined();
  }
};

// A change snapshot that any runtime can rebuild into its own Value.
struct SVSnapshot {
  int mode;
  double num;
  std::shared_ptr<const Message> msg;
};

void notify(SVCell& cell, const SVSnapshot& snap) {
  if (!cell.hasSubs.load(std::memory_order_acquire)) return;
  std::vector<std::shared_ptr<SVSubscriber>> targets;
  {
    std::lock_guard<std::mutex> lock(cell.mutex);
    targets = cell.subs;
  }
  if (targets.empty()) return;
  auto snapshot = std::make_shared<SVSnapshot>(snap);
  for (auto& sub : targets) {
    sub->poster([sub, snapshot](Runtime& rt) {
      if (!sub->alive->load()) return;
      auto cb = sub->callback;
      if (!cb) return;
      try {
        Value v = snapshot->mode == 0 ? Value(snapshot->num)
            : snapshot->mode == 2     ? Value::undefined()
            : snapshot->msg           ? decode(rt, *snapshot->msg)
                                      : Value::undefined();
        cb->call(rt, std::move(v));
      } catch (...) {
      }
    });
  }
}

// Write `v` into the cell and notify. Number writes are lock-free when nobody is
// subscribed (the common animation case).
void write(SVCell& cell, Runtime& rt, const Value& v) {
  if (v.isNumber()) {
    double d = v.getNumber();
    cell.num.store(d, std::memory_order_relaxed);
    cell.mode.store(0, std::memory_order_release);
    notify(cell, SVSnapshot{0, d, nullptr});
  } else if (v.isUndefined() || v.isNull()) {
    cell.mode.store(2, std::memory_order_release);
    notify(cell, SVSnapshot{2, 0, nullptr});
  } else {
    auto mm = std::make_shared<const Message>(encode(rt, v));
    {
      std::lock_guard<std::mutex> lock(cell.mutex);
      cell.msg = mm;
    }
    cell.mode.store(1, std::memory_order_release);
    notify(cell, SVSnapshot{1, 0, mm});
  }
}

std::mutex& registryMutex() {
  static std::mutex m;
  return m;
}
// The registry is WEAK: it maps a name to a cell without owning it, so a cell
// lives exactly as long as something is actually using it and is freed
// automatically once nothing is — no manual bookkeeping, and no unbounded growth
// from dynamically generated names.
//
// Ownership comes from the users themselves, across every runtime at once:
//   * each JS handle holds a shared_ptr (SharedValueHandle),
//   * each live subscription holds one (SVRuntimeSubs), so subscribing alone is
//     enough to keep a cell alive even with no handle retained.
// When the last of those goes — a handle becoming unreachable in ANY runtime and
// being collected, a worker terminating, an unsubscribe — the cell dies with it.
//
// The consequence to know: a name is not a persistent store. Nothing holding a
// reference means the data is gone, and the next open re-seeds a fresh cell. Hold
// a reference for as long as you want the data to survive.
std::unordered_map<std::string, std::weak_ptr<SVCell>>& registry() {
  static std::unordered_map<std::string, std::weak_ptr<SVCell>> r;
  return r;
}

// Drop map entries whose cell is gone. The entries themselves are tiny, but a
// long-lived process cycling through generated names would otherwise accumulate
// them forever — a smaller leak of the same shape we are removing. Called only
// when a new cell is created, and only past a threshold, so steady-state opens of
// existing names stay O(1). Caller holds registryMutex().
void sweepExpiredLocked(std::unordered_map<std::string, std::weak_ptr<SVCell>>& r) {
  if (r.size() < 32) return;
  for (auto it = r.begin(); it != r.end();) {
    if (it->second.expired()) it = r.erase(it);
    else ++it;
  }
}

std::shared_ptr<SVCell> openCell(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = registry();
  auto it = r.find(name);
  if (it != r.end()) {
    // `lock()` fails once the last owner dropped it: the name is stale, so fall
    // through and install a fresh cell under it.
    if (auto alive = it->second.lock()) return alive;
  }
  sweepExpiredLocked(r);
  auto cell = std::make_shared<SVCell>();
  r[name] = cell;
  return cell;
}

// Force a name to be forgotten NOW, before its owners have let go. Refcounting
// makes this unnecessary for cleanup; it remains useful to deliberately orphan a
// name so the next open starts fresh. Existing handles keep working against the
// orphaned cell (no dangling) but no longer share with anyone opening the name
// afterwards. Returns whether the name was still live.
bool releaseCell(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = registry();
  auto it = r.find(name);
  if (it == r.end()) return false;
  bool wasLive = !it->second.expired();
  r.erase(it);
  return wasLive;
}

// Per-runtime record of the SharedValue subscriptions it created, so teardown can
// remove them all (mirrors SharedStore's RuntimeSubscriptions).
struct SVRuntimeSubs {
  std::mutex mutex;
  std::vector<std::pair<std::shared_ptr<SVCell>, std::shared_ptr<SVSubscriber>>>
      entries;
  void add(std::shared_ptr<SVCell> cell, std::shared_ptr<SVSubscriber> sub) {
    std::lock_guard<std::mutex> lock(mutex);
    entries.emplace_back(std::move(cell), std::move(sub));
  }
  // Pointer identity, not id: ids are per-cell (nextSubId), so subscriptions on
  // two different cells can share an id and an id-based erase could remove the
  // wrong cell's entry (see the same fix in SharedStore's RuntimeSubscriptions).
  void remove(const SVSubscriber* sub) {
    std::lock_guard<std::mutex> lock(mutex);
    for (size_t i = 0; i < entries.size(); ++i) {
      if (entries[i].second.get() == sub) {
        entries.erase(entries.begin() + i);
        return;
      }
    }
  }
};

class SharedValueHandle : public HostObject {
 public:
  SharedValueHandle(
      std::shared_ptr<SVCell> cell,
      RuntimePoster poster,
      std::shared_ptr<SVRuntimeSubs> runtimeSubs)
      : cell_(std::move(cell)),
        poster_(std::move(poster)),
        runtimeSubs_(std::move(runtimeSubs)) {}

  Value get(Runtime& rt, const PropNameID& name) override {
    std::string prop = name.utf8(rt);
    if (prop == "value") return cell_->read(rt);
    if (prop == "subscribe") return makeSubscribe(rt);
    return Value::undefined();
  }

  void set(Runtime& rt, const PropNameID& name, const Value& value) override {
    if (name.utf8(rt) == "value") write(*cell_, rt, value);
  }

  std::vector<PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<PropNameID> names;
    names.push_back(PropNameID::forAscii(rt, "value"));
    names.push_back(PropNameID::forAscii(rt, "subscribe"));
    return names;
  }

 private:
  Value makeSubscribe(Runtime& rt) {
    auto cell = cell_;
    auto poster = poster_;
    auto runtimeSubs = runtimeSubs_;
    return Function::createFromHostFunction(
        rt,
        PropNameID::forAscii(rt, "subscribe"),
        1,
        [cell, poster, runtimeSubs](
            Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          if (count < 1 || !args[0].isObject() ||
              !args[0].getObject(rt).isFunction(rt))
            throw JSError(rt, "subscribe(cb) requires a function");
          auto sub = std::make_shared<SVSubscriber>();
          sub->poster = poster;
          sub->callback =
              std::make_shared<Function>(args[0].getObject(rt).getFunction(rt));
          sub->alive = std::make_shared<std::atomic<bool>>(true);
          {
            std::lock_guard<std::mutex> lock(cell->mutex);
            sub->id = cell->nextSubId++;
            cell->subs.push_back(sub);
            cell->hasSubs.store(true, std::memory_order_release);
          }
          runtimeSubs->add(cell, sub);
          return Function::createFromHostFunction(
              rt,
              PropNameID::forAscii(rt, "unsubscribe"),
              0,
              [cell, sub, runtimeSubs](
                  Runtime&, const Value&, const Value*, size_t) -> Value {
                sub->alive->store(false);
                {
                  std::lock_guard<std::mutex> lock(cell->mutex);
                  auto& s = cell->subs;
                  for (size_t i = 0; i < s.size(); ++i) {
                    if (s[i]->id == sub->id) {
                      s.erase(s.begin() + i);
                      break;
                    }
                  }
                  if (s.empty())
                    cell->hasSubs.store(false, std::memory_order_release);
                }
                runtimeSubs->remove(sub.get());
                return Value::undefined();
              });
        });
  }

  std::shared_ptr<SVCell> cell_;
  RuntimePoster poster_;
  std::shared_ptr<SVRuntimeSubs> runtimeSubs_;
};

} // namespace

std::function<void(Runtime&)> installSharedValue(
    Runtime& rt,
    RuntimePoster poster) {
  auto runtimeSubs = std::make_shared<SVRuntimeSubs>();
  rt.global().setProperty(
      rt,
      "__rnworkersOpenSharedValue",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersOpenSharedValue"),
          2,
          [poster, runtimeSubs](
              Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            std::string name =
                count > 0 && args[0].isString() ? args[0].getString(rt).utf8(rt)
                                                : std::string("default");
            auto cell = openCell(name);
            // Seed the initial value only if the cell is brand new (mode still
            // "undefined") and an initial was provided.
            if (count > 1 && !args[1].isUndefined() &&
                cell->mode.load(std::memory_order_acquire) == 2) {
              write(*cell, rt, args[1]);
            }
            return Value(Object::createFromHostObject(
                rt,
                std::make_shared<SharedValueHandle>(cell, poster, runtimeSubs)));
          }));

  rt.global().setProperty(
      rt,
      "__rnworkersDeleteSharedValue",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersDeleteSharedValue"),
          1,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 1 || !args[0].isString())
              throw JSError(rt, "SharedValue.delete(name) requires a string");
            return Value(releaseCell(args[0].getString(rt).utf8(rt)));
          }));

  return [runtimeSubs](Runtime&) {
    std::vector<std::pair<std::shared_ptr<SVCell>, std::shared_ptr<SVSubscriber>>>
        entries;
    {
      std::lock_guard<std::mutex> lock(runtimeSubs->mutex);
      entries.swap(runtimeSubs->entries);
    }
    for (auto& e : entries) {
      auto& cell = e.first;
      auto& sub = e.second;
      sub->alive->store(false);
      {
        std::lock_guard<std::mutex> lock(cell->mutex);
        auto& s = cell->subs;
        for (size_t i = 0; i < s.size(); ++i) {
          if (s[i]->id == sub->id) {
            s.erase(s.begin() + i);
            break;
          }
        }
        if (s.empty()) cell->hasSubs.store(false, std::memory_order_release);
      }
      sub->callback.reset();
    }
  };
}

} // namespace facebook::react::workers
