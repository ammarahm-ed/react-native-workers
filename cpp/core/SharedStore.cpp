#include "SharedStore.h"

#include "MessageCodec.h"

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace facebook::react::workers {

using namespace facebook::jsi;

namespace {

// ---------------------------------------------------------------------------
// Node tree
//
// A stored value is an immutable, structurally-shared tree instead of one flat
// encoded blob. Only *leaves* carry encoded bytes; objects/arrays are just maps/
// vectors of child-node pointers. This gives:
//   * lazy reads   — `get` returns a proxy that decodes only the leaves touched;
//   * granular writes — `setIn(path, v)` encodes only `v` and copy-on-write
//     rebuilds just the root->path spine, sharing every untouched sibling;
//   * granular notify — watchers receive only the changed slice, not the whole
//     value.
// Nodes are immutable (`shared_ptr<const Node>`) so a `get` snapshot stays
// consistent even while another runtime writes, and writes never copy siblings.
// ---------------------------------------------------------------------------
struct Node {
  enum class Kind { Leaf, Object, Array };
  // A Leaf is either a primitive stored INLINE (no codec round-trip — this keeps
  // scalar-heavy data like a 50k-number array cheap to explode/decode) or, for
  // anything the flat codec must handle (typed arrays, ArrayBuffer, Date, class
  // instances…), an encoded Message.
  enum class Leaf { Message, Null, Bool, Number, String };
  Kind kind;
  Leaf leafKind = Leaf::Message;
  std::shared_ptr<const Message> msg;                  // Leaf::Message
  double num = 0;                                      // Leaf::Number
  bool boolean = false;                                // Leaf::Bool
  std::string str;                                     // Leaf::String
  std::map<std::string, std::shared_ptr<const Node>> obj; // Kind::Object
  std::vector<std::shared_ptr<const Node>> arr;        // Kind::Array
};
using NodePtr = std::shared_ptr<const Node>;

NodePtr makeMessageLeaf(Message m) {
  auto n = std::make_shared<Node>();
  n->kind = Node::Kind::Leaf;
  n->leafKind = Node::Leaf::Message;
  n->msg = std::make_shared<const Message>(std::move(m));
  return n;
}

// A single step of an access path: an object key or an array index.
struct PathSeg {
  bool isIndex;
  std::string key;
  size_t index;
};
using Path = std::vector<PathSeg>;

Path readPath(Runtime& rt, const Value& v) {
  Path path;
  if (!v.isObject() || !v.getObject(rt).isArray(rt)) return path;
  Array a = v.getObject(rt).getArray(rt);
  size_t n = a.size(rt);
  path.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    Value seg = a.getValueAtIndex(rt, i);
    PathSeg ps{};
    if (seg.isNumber()) {
      ps.isIndex = true;
      ps.index = static_cast<size_t>(seg.asNumber());
    } else {
      ps.isIndex = false;
      ps.key = seg.asString(rt).utf8(rt);
    }
    path.push_back(std::move(ps));
  }
  return path;
}

// Is `p` a prefix of (or equal to) `c`?
bool isPrefix(const Path& p, const Path& c) {
  if (p.size() > c.size()) return false;
  for (size_t i = 0; i < p.size(); ++i) {
    if (p[i].isIndex != c[i].isIndex) return false;
    if (p[i].isIndex) {
      if (p[i].index != c[i].index) return false;
    } else if (p[i].key != c[i].key) {
      return false;
    }
  }
  return true;
}

NodePtr navigate(NodePtr node, const Path& path) {
  for (const auto& s : path) {
    if (!node) return nullptr;
    if (s.isIndex) {
      if (node->kind != Node::Kind::Array || s.index >= node->arr.size())
        return nullptr;
      node = node->arr[s.index];
    } else {
      if (node->kind != Node::Kind::Object) return nullptr;
      auto it = node->obj.find(s.key);
      if (it == node->obj.end()) return nullptr;
      node = it->second;
    }
  }
  return node;
}

// Copy-on-write: return a new tree identical to `root` except the node at `path`
// (from index `i`) is `newChild`. Only the nodes along the spine are rebuilt;
// every untouched subtree is pointer-shared with `root`. Missing intermediate
// nodes are created (objects, or arrays padded with holes) like lodash `set`.
NodePtr setInNode(
    const NodePtr& root,
    const Path& path,
    size_t i,
    const NodePtr& newChild) {
  if (i == path.size()) return newChild;
  const PathSeg& s = path[i];
  if (s.isIndex) {
    auto node = std::make_shared<Node>();
    node->kind = Node::Kind::Array;
    if (root && root->kind == Node::Kind::Array) node->arr = root->arr;
    if (s.index >= node->arr.size()) node->arr.resize(s.index + 1, nullptr);
    node->arr[s.index] = setInNode(node->arr[s.index], path, i + 1, newChild);
    return node;
  }
  auto node = std::make_shared<Node>();
  node->kind = Node::Kind::Object;
  if (root && root->kind == Node::Kind::Object) node->obj = root->obj;
  NodePtr child;
  auto it = node->obj.find(s.key);
  if (it != node->obj.end()) child = it->second;
  node->obj[s.key] = setInNode(child, path, i + 1, newChild);
  return node;
}

// Copy-on-write remove of the node at `path`. `changed` reports whether anything
// was actually removed (path existed). Array removal splices (shifts indices).
NodePtr deleteInNode(
    const NodePtr& root,
    const Path& path,
    size_t i,
    bool& changed) {
  changed = false;
  if (!root) return root;
  const PathSeg& s = path[i];
  bool last = (i + 1 == path.size());
  if (s.isIndex) {
    if (root->kind != Node::Kind::Array || s.index >= root->arr.size())
      return root;
    auto node = std::make_shared<Node>();
    node->kind = Node::Kind::Array;
    node->arr = root->arr;
    if (last) {
      node->arr.erase(node->arr.begin() + s.index);
      changed = true;
    } else {
      node->arr[s.index] = deleteInNode(root->arr[s.index], path, i + 1, changed);
      if (!changed) return root;
    }
    return node;
  }
  if (root->kind != Node::Kind::Object) return root;
  auto it = root->obj.find(s.key);
  if (it == root->obj.end()) return root;
  auto node = std::make_shared<Node>();
  node->kind = Node::Kind::Object;
  node->obj = root->obj;
  if (last) {
    node->obj.erase(s.key);
    changed = true;
  } else {
    node->obj[s.key] = deleteInNode(it->second, path, i + 1, changed);
    if (!changed) return root;
  }
  return node;
}

// Deep-merge `patch` into `base` (copy-on-write). Two Object nodes merge key by
// key; anything else (array/leaf, or a type mismatch) is replaced by `patch`.
NodePtr mergeNode(const NodePtr& base, const NodePtr& patch) {
  if (!patch) return base;
  if (!base || base->kind != Node::Kind::Object ||
      patch->kind != Node::Kind::Object)
    return patch;
  auto node = std::make_shared<Node>();
  node->kind = Node::Kind::Object;
  node->obj = base->obj;
  for (auto& kv : patch->obj) {
    auto it = base->obj.find(kv.first);
    node->obj[kv.first] =
        mergeNode(it != base->obj.end() ? it->second : nullptr, kv.second);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Lazy read side: turn a Node subtree into a JS value that decodes on demand.
// ---------------------------------------------------------------------------
Value nodeToValue(Runtime& rt, const NodePtr& node);

// Object nodes surface as this HostObject: each property access decodes only
// that child. It holds the (immutable) node, so it is a stable snapshot.
class ObjectProxy : public HostObject {
 public:
  explicit ObjectProxy(NodePtr node) : node_(std::move(node)) {}

  Value get(Runtime& rt, const PropNameID& name) override {
    std::string k = name.utf8(rt);
    auto it = node_->obj.find(k);
    if (it == node_->obj.end()) return Value::undefined();
    return nodeToValue(rt, it->second);
  }

  void set(Runtime&, const PropNameID&, const Value&) override {
    // Snapshots are read-only; writes must go through the store (setIn).
  }

  std::vector<PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<PropNameID> names;
    names.reserve(node_->obj.size());
    for (auto& kv : node_->obj)
      names.push_back(PropNameID::forUtf8(rt, kv.first));
    return names;
  }

 private:
  NodePtr node_;
};

Value nodeToValue(Runtime& rt, const NodePtr& node) {
  if (!node) return Value::undefined();
  switch (node->kind) {
    case Node::Kind::Leaf:
      switch (node->leafKind) {
        case Node::Leaf::Null:
          return Value::null();
        case Node::Leaf::Bool:
          return Value(node->boolean);
        case Node::Leaf::Number:
          return Value(node->num);
        case Node::Leaf::String:
          return Value(String::createFromUtf8(rt, node->str));
        case Node::Leaf::Message:
          return decode(rt, *node->msg);
      }
      return Value::undefined();
    case Node::Kind::Object:
      return Value(
          Object::createFromHostObject(rt, std::make_shared<ObjectProxy>(node)));
    case Node::Kind::Array: {
      // Arrays materialize as a real JS array (so map/spread/iteration work);
      // each element is produced lazily — leaves decode now, object/array
      // elements become nested lazy values, so deep content stays deferred.
      size_t n = node->arr.size();
      Array arr(rt, n);
      for (size_t i = 0; i < n; ++i)
        arr.setValueAtIndex(rt, i, nodeToValue(rt, node->arr[i]));
      return Value(std::move(arr));
    }
  }
  return Value::undefined();
}

// ---------------------------------------------------------------------------
// Subscribers + notification
// ---------------------------------------------------------------------------
struct Subscriber {
  uint64_t id;
  std::string key;   // watched key (unused when watchAll)
  bool watchAll;     // watch() — fires for any key
  bool granular;     // subscribeIn() — delivers (relPath, slice)
  Path path;         // granular watch path
  RuntimePoster poster;
  std::shared_ptr<Function> callback; // touched only on its own runtime thread
  std::shared_ptr<std::atomic<bool>> alive;
};

// Deliver a change to the interested subscribers on each one's runtime thread.
// `newRoot` is the whole value's new tree (immutable, shared — no copy); the
// posted task decodes only the slice the subscriber cares about, in its runtime.
void dispatchChange(
    const std::vector<std::shared_ptr<Subscriber>>& targets,
    const std::string& key,
    const Path& changedPath,
    const NodePtr& newRoot) {
  auto sharedKey = std::make_shared<std::string>(key);
  auto sharedChanged = std::make_shared<Path>(changedPath);
  for (auto& sub : targets) {
    if (!sub->granular) {
      // Legacy subscribe/watch: fire on any change to the key with (key, value).
      sub->poster([sub, sharedKey, newRoot](Runtime& rt) {
        if (!sub->alive->load()) return;
        auto cb = sub->callback;
        if (!cb) return;
        try {
          cb->call(
              rt,
              String::createFromUtf8(rt, *sharedKey),
              nodeToValue(rt, newRoot));
        } catch (...) {
        }
      });
      continue;
    }
    // Granular: fire only when the watched path and the changed path are on the
    // same branch. Deliver the changed slice relative to the watch path.
    bool watchAtOrAbove = isPrefix(sub->path, changedPath); // change is in subtree
    bool watchBelow = isPrefix(changedPath, sub->path); // an ancestor changed
    if (!watchAtOrAbove && !watchBelow) continue;
    // valuePath: the deeper of the two paths (what actually to read from newRoot).
    auto valuePath = std::make_shared<Path>(
        watchAtOrAbove ? changedPath : sub->path);
    auto relPath = std::make_shared<Path>();
    if (watchAtOrAbove) {
      relPath->assign(
          sharedChanged->begin() + sub->path.size(), sharedChanged->end());
    }
    sub->poster([sub, relPath, valuePath, newRoot](Runtime& rt) {
      if (!sub->alive->load()) return;
      auto cb = sub->callback;
      if (!cb) return;
      try {
        Array rel(rt, relPath->size());
        for (size_t i = 0; i < relPath->size(); ++i) {
          if ((*relPath)[i].isIndex)
            rel.setValueAtIndex(
                rt, i, Value(static_cast<double>((*relPath)[i].index)));
          else
            rel.setValueAtIndex(
                rt, i, String::createFromUtf8(rt, (*relPath)[i].key));
        }
        cb->call(
            rt,
            Value(std::move(rel)),
            nodeToValue(rt, navigate(newRoot, *valuePath)));
      } catch (...) {
      }
    });
  }
}

struct StoreData {
  std::mutex mutex;
  std::unordered_map<std::string, NodePtr> roots;
  std::vector<std::shared_ptr<Subscriber>> subscribers;
  uint64_t nextSubId = 1;

  // Caller MUST hold `mutex`. Subscribers watching this key (or all keys).
  std::vector<std::shared_ptr<Subscriber>> matchingLocked(
      const std::string& key) {
    std::vector<std::shared_ptr<Subscriber>> t;
    for (auto& s : subscribers)
      if (s->watchAll || s->key == key) t.push_back(s);
    return t;
  }
};

// Tracks every subscription a single runtime created, so they can all be removed
// when that runtime tears down (a Subscriber lives in the process-global
// StoreData and would otherwise outlive its worker). One per installSharedStore.
struct RuntimeSubscriptions {
  std::mutex mutex;
  std::vector<std::pair<std::shared_ptr<StoreData>, std::shared_ptr<Subscriber>>>
      entries;

  void add(std::shared_ptr<StoreData> store, std::shared_ptr<Subscriber> sub) {
    std::lock_guard<std::mutex> lock(mutex);
    entries.emplace_back(std::move(store), std::move(sub));
  }

  void remove(uint64_t subId) {
    std::lock_guard<std::mutex> lock(mutex);
    for (size_t i = 0; i < entries.size(); ++i) {
      if (entries[i].second->id == subId) {
        entries.erase(entries.begin() + i);
        return;
      }
    }
  }
};

// Per-runtime batch context. `store.batch(fn)` bumps `depth`; while depth > 0,
// writes still apply immediately (reads stay consistent) but their notifications
// are DEFERRED and coalesced — recorded as (store, key) pairs and flushed once,
// as a single whole-key notification per affected key, when depth returns to 0.
// Runs entirely on one runtime's thread, so no lock is needed.
struct BatchContext {
  int depth = 0;
  std::vector<std::pair<std::shared_ptr<StoreData>, std::string>> changes;

  void record(std::shared_ptr<StoreData> store, const std::string& key) {
    for (auto& c : changes)
      if (c.first == store && c.second == key) return; // dedup
    changes.emplace_back(std::move(store), key);
  }
};

std::mutex& registryMutex() {
  static std::mutex m;
  return m;
}
// WEAK registry — see the explanation in SharedValue.cpp. Owners here are the
// per-runtime StoreHandles and any live subscription (RuntimeSubscriptions), so a
// store lives while any runtime is using or watching it and is freed once none is.
std::unordered_map<std::string, std::weak_ptr<StoreData>>& registry() {
  static std::unordered_map<std::string, std::weak_ptr<StoreData>> r;
  return r;
}

void sweepExpiredLocked(
    std::unordered_map<std::string, std::weak_ptr<StoreData>>& r) {
  if (r.size() < 32) return;
  for (auto it = r.begin(); it != r.end();) {
    if (it->second.expired()) it = r.erase(it);
    else ++it;
  }
}

std::shared_ptr<StoreData> openStore(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = registry();
  auto it = r.find(name);
  if (it != r.end()) {
    if (auto alive = it->second.lock()) return alive;
  }
  sweepExpiredLocked(r);
  auto data = std::make_shared<StoreData>();
  r[name] = data;
  return data;
}

// See releaseCell in SharedValue.cpp — force the name to be forgotten now.
bool releaseStore(const std::string& name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto& r = registry();
  auto it = r.find(name);
  if (it == r.end()) return false;
  bool wasLive = !it->second.expired();
  r.erase(it);
  return wasLive;
}

// A per-runtime handle to a named store. Its methods are bound ONCE into a plain
// JS object (see toObject) so repeated calls are ordinary property reads, not a
// HostObject dispatch that re-creates a Function each time.
class StoreHandle : public std::enable_shared_from_this<StoreHandle> {
 public:
  StoreHandle(
      std::shared_ptr<StoreData> data,
      RuntimePoster poster,
      std::shared_ptr<RuntimeSubscriptions> runtimeSubs,
      std::shared_ptr<Function> classifier,
      std::shared_ptr<BatchContext> batch)
      : data_(std::move(data)),
        poster_(std::move(poster)),
        runtimeSubs_(std::move(runtimeSubs)),
        classifier_(std::move(classifier)),
        batch_(std::move(batch)) {}

  Object toObject(Runtime& rt) {
    auto self = shared_from_this();
    Object obj(rt);
    auto bind = [&](const char* name, unsigned argc, Method m) {
      obj.setProperty(
          rt,
          name,
          Function::createFromHostFunction(
              rt,
              PropNameID::forAscii(rt, name),
              argc,
              [self, m](
                  Runtime& rt, const Value&, const Value* args, size_t count) {
                return ((*self).*m)(rt, args, count);
              }));
    };
    bind("get", 1, &StoreHandle::jsGet);
    bind("set", 2, &StoreHandle::jsSet);
    bind("getIn", 2, &StoreHandle::jsGetIn);
    bind("setIn", 3, &StoreHandle::jsSetIn);
    bind("merge", 2, &StoreHandle::jsMerge);
    bind("deleteIn", 2, &StoreHandle::jsDeleteIn);
    bind("has", 1, &StoreHandle::jsHas);
    bind("delete", 1, &StoreHandle::jsDelete);
    bind("keys", 0, &StoreHandle::jsKeys);
    bind("subscribe", 2, &StoreHandle::jsSubscribe);
    bind("subscribeIn", 3, &StoreHandle::jsSubscribeIn);
    bind("watch", 1, &StoreHandle::jsWatch);
    bind("batch", 1, &StoreHandle::jsBatch);
    bind("batchBegin", 0, &StoreHandle::jsBatchBegin);
    bind("batchEnd", 0, &StoreHandle::jsBatchEnd);
    return obj;
  }

 private:
  using Method = Value (StoreHandle::*)(Runtime&, const Value*, size_t);

  // Build a Node subtree from a JS value. Objects/arrays explode into
  // Object/Array nodes; scalars, binary, Date, typed arrays, class instances,
  // etc. become a single Leaf (encoded whole). `encode` throws DataCloneError on
  // non-cloneable values (e.g. functions) — callers translate that to a JSError.
  NodePtr buildNode(Runtime& rt, const Value& v) {
    // Primitives store inline — no encode/Message allocation per value.
    if (v.isNumber()) {
      auto n = std::make_shared<Node>();
      n->kind = Node::Kind::Leaf;
      n->leafKind = Node::Leaf::Number;
      n->num = v.getNumber();
      return n;
    }
    if (v.isBool()) {
      auto n = std::make_shared<Node>();
      n->kind = Node::Kind::Leaf;
      n->leafKind = Node::Leaf::Bool;
      n->boolean = v.getBool();
      return n;
    }
    if (v.isNull() || v.isUndefined()) {
      auto n = std::make_shared<Node>();
      n->kind = Node::Kind::Leaf;
      n->leafKind = Node::Leaf::Null;
      return n;
    }
    if (v.isString()) {
      auto n = std::make_shared<Node>();
      n->kind = Node::Kind::Leaf;
      n->leafKind = Node::Leaf::String;
      n->str = v.getString(rt).utf8(rt);
      return n;
    }
    if (!v.isObject()) return makeMessageLeaf(encode(rt, v)); // symbol/bigint/…
    Object o = v.getObject(rt);
    if (o.isArray(rt)) {
      Array a = o.getArray(rt);
      size_t n = a.size(rt);
      auto node = std::make_shared<Node>();
      node->kind = Node::Kind::Array;
      node->arr.reserve(n);
      for (size_t i = 0; i < n; ++i)
        node->arr.push_back(buildNode(rt, a.getValueAtIndex(rt, i)));
      return node;
    }
    if (o.isArrayBuffer(rt)) return makeMessageLeaf(encode(rt, v));
    // Only plain objects (prototype Object.prototype / null) explode; anything
    // else (Date, TypedArray, Map, Set, class instance) is a leaf so the codec
    // preserves it. If classification fails, fall back to leaf (never crash).
    bool plain = false;
    if (classifier_) {
      try {
        plain = classifier_->call(rt, v).asNumber() == 1;
      } catch (...) {
        plain = false;
      }
    }
    if (!plain) return makeMessageLeaf(encode(rt, v));
    auto node = std::make_shared<Node>();
    node->kind = Node::Kind::Object;
    Array names = o.getPropertyNames(rt);
    size_t n = names.size(rt);
    for (size_t i = 0; i < n; ++i) {
      String nameStr = names.getValueAtIndex(rt, i).asString(rt);
      std::string key = nameStr.utf8(rt);
      node->obj[key] = buildNode(rt, o.getProperty(rt, nameStr));
    }
    return node;
  }

  NodePtr buildNodeChecked(Runtime& rt, const Value& v) {
    try {
      return buildNode(rt, v);
    } catch (const DataCloneError& e) {
      throw JSError(rt, e.what());
    }
  }

  NodePtr rootFor(const std::string& key) {
    std::lock_guard<std::mutex> lock(data_->mutex);
    auto it = data_->roots.find(key);
    return it != data_->roots.end() ? it->second : nullptr;
  }

  Value jsGet(Runtime& rt, const Value* args, size_t count) {
    if (count < 1) return Value::undefined();
    return nodeToValue(rt, rootFor(args[0].asString(rt).utf8(rt)));
  }

  Value jsGetIn(Runtime& rt, const Value* args, size_t count) {
    if (count < 2) return Value::undefined();
    NodePtr root = rootFor(args[0].asString(rt).utf8(rt));
    return nodeToValue(rt, navigate(root, readPath(rt, args[1])));
  }

  Value jsSet(Runtime& rt, const Value* args, size_t count) {
    if (count < 2) throw JSError(rt, "set(key, value) requires 2 arguments");
    std::string key = args[0].asString(rt).utf8(rt);
    NodePtr root = buildNodeChecked(rt, args[1]);
    std::vector<std::shared_ptr<Subscriber>> targets;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      data_->roots[key] = root;
      if (batch_->depth == 0 && !data_->subscribers.empty())
        targets = data_->matchingLocked(key);
    }
    if (batch_->depth > 0) batch_->record(data_, key);
    else if (!targets.empty()) dispatchChange(targets, key, Path{}, root);
    return Value::undefined();
  }

  Value jsSetIn(Runtime& rt, const Value* args, size_t count) {
    if (count < 3)
      throw JSError(rt, "setIn(key, path, value) requires 3 arguments");
    std::string key = args[0].asString(rt).utf8(rt);
    Path path = readPath(rt, args[1]);
    if (path.empty()) {
      // setIn(key, [], value) is just set(key, value).
      const Value setArgs[] = {Value(rt, args[0]), Value(rt, args[2])};
      return jsSet(rt, setArgs, 2);
    }
    NodePtr child = buildNodeChecked(rt, args[2]);
    NodePtr newRoot;
    std::vector<std::shared_ptr<Subscriber>> targets;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      NodePtr old;
      auto it = data_->roots.find(key);
      if (it != data_->roots.end()) old = it->second;
      newRoot = setInNode(old, path, 0, child);
      data_->roots[key] = newRoot;
      if (batch_->depth == 0 && !data_->subscribers.empty())
        targets = data_->matchingLocked(key);
    }
    if (batch_->depth > 0) batch_->record(data_, key);
    else if (!targets.empty()) dispatchChange(targets, key, path, newRoot);
    return Value::undefined();
  }

  // Deep-merge a partial object into the stored value. Notifies at the key root
  // (a merge can touch many paths); granular watchers receive their subtree.
  Value jsMerge(Runtime& rt, const Value* args, size_t count) {
    if (count < 2) throw JSError(rt, "merge(key, partial) requires 2 arguments");
    std::string key = args[0].asString(rt).utf8(rt);
    NodePtr patch = buildNodeChecked(rt, args[1]);
    NodePtr newRoot;
    std::vector<std::shared_ptr<Subscriber>> targets;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      NodePtr old;
      auto it = data_->roots.find(key);
      if (it != data_->roots.end()) old = it->second;
      newRoot = mergeNode(old, patch);
      data_->roots[key] = newRoot;
      if (batch_->depth == 0 && !data_->subscribers.empty())
        targets = data_->matchingLocked(key);
    }
    if (batch_->depth > 0) batch_->record(data_, key);
    else if (!targets.empty()) dispatchChange(targets, key, Path{}, newRoot);
    return Value::undefined();
  }

  Value jsDeleteIn(Runtime& rt, const Value* args, size_t count) {
    if (count < 2)
      throw JSError(rt, "deleteIn(key, path) requires 2 arguments");
    std::string key = args[0].asString(rt).utf8(rt);
    Path path = readPath(rt, args[1]);
    if (path.empty()) return jsDelete(rt, args, 1);
    bool changed = false;
    NodePtr newRoot;
    std::vector<std::shared_ptr<Subscriber>> targets;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      auto it = data_->roots.find(key);
      if (it == data_->roots.end()) return Value(false);
      newRoot = deleteInNode(it->second, path, 0, changed);
      if (changed) {
        data_->roots[key] = newRoot;
        if (batch_->depth == 0 && !data_->subscribers.empty())
          targets = data_->matchingLocked(key);
      }
    }
    if (changed && batch_->depth > 0) batch_->record(data_, key);
    else if (changed && !targets.empty())
      dispatchChange(targets, key, path, newRoot);
    return Value(changed);
  }

  Value jsHas(Runtime& rt, const Value* args, size_t count) {
    if (count < 1) return Value(false);
    std::string key = args[0].asString(rt).utf8(rt);
    std::lock_guard<std::mutex> lock(data_->mutex);
    return Value(data_->roots.find(key) != data_->roots.end());
  }

  Value jsDelete(Runtime& rt, const Value* args, size_t count) {
    if (count < 1) return Value(false);
    std::string key = args[0].asString(rt).utf8(rt);
    bool erased;
    std::vector<std::shared_ptr<Subscriber>> targets;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      erased = data_->roots.erase(key) > 0;
      if (erased && batch_->depth == 0 && !data_->subscribers.empty())
        targets = data_->matchingLocked(key);
    }
    if (erased && batch_->depth > 0) batch_->record(data_, key);
    else if (!targets.empty()) dispatchChange(targets, key, Path{}, nullptr);
    return Value(erased);
  }

  // Flush the deferred, coalesced notifications: one whole-key notification per
  // changed key (deduped). Called when batch depth returns to 0.
  void flushBatch() {
    auto changes = std::move(batch_->changes);
    batch_->changes.clear();
    for (auto& ch : changes) {
      auto& store = ch.first;
      auto& key = ch.second;
      std::vector<std::shared_ptr<Subscriber>> targets;
      NodePtr newRoot;
      {
        std::lock_guard<std::mutex> lock(store->mutex);
        if (store->subscribers.empty()) continue;
        targets = store->matchingLocked(key);
        auto it = store->roots.find(key);
        newRoot = it != store->roots.end() ? it->second : nullptr;
      }
      if (!targets.empty()) dispatchChange(targets, key, Path{}, newRoot);
    }
  }

  // batch(fn): run fn with notifications deferred; on exit, emit one coalesced
  // whole-key notification per key that changed. Writes inside fn apply
  // immediately, so reads stay consistent. Nesting is supported (flush at depth 0).
  Value jsBatch(Runtime& rt, const Value* args, size_t count) {
    if (count < 1 || !args[0].isObject() || !args[0].getObject(rt).isFunction(rt))
      throw JSError(rt, "batch(fn) requires a function");
    Function fn = args[0].getObject(rt).getFunction(rt);
    batch_->depth++;
    std::exception_ptr err;
    try {
      fn.call(rt);
    } catch (...) {
      err = std::current_exception();
    }
    batch_->depth--;
    if (batch_->depth == 0) flushBatch();
    if (err) std::rethrow_exception(err);
    return Value::undefined();
  }

  // Manual batch bracket (used by the reactive-state layer to coalesce a whole
  // tick's assignments: begin on the first write, end on the microtask).
  Value jsBatchBegin(Runtime&, const Value*, size_t) {
    batch_->depth++;
    return Value::undefined();
  }
  Value jsBatchEnd(Runtime&, const Value*, size_t) {
    if (batch_->depth > 0) batch_->depth--;
    if (batch_->depth == 0) flushBatch();
    return Value::undefined();
  }

  Value jsKeys(Runtime& rt, const Value*, size_t) {
    std::vector<std::string> keys;
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      keys.reserve(data_->roots.size());
      for (auto& kv : data_->roots) keys.push_back(kv.first);
    }
    Array arr(rt, keys.size());
    for (size_t i = 0; i < keys.size(); ++i)
      arr.setValueAtIndex(rt, i, String::createFromUtf8(rt, keys[i]));
    return Value(std::move(arr));
  }

  Value subscribeImpl(
      Runtime& rt,
      const std::string& key,
      bool watchAll,
      bool granular,
      Path path,
      const Value& cbVal) {
    if (!cbVal.isObject() || !cbVal.getObject(rt).isFunction(rt))
      throw JSError(rt, "a function callback is required");
    auto sub = std::make_shared<Subscriber>();
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      sub->id = data_->nextSubId++;
    }
    sub->key = key;
    sub->watchAll = watchAll;
    sub->granular = granular;
    sub->path = std::move(path);
    sub->poster = poster_;
    sub->callback =
        std::make_shared<Function>(cbVal.getObject(rt).getFunction(rt));
    sub->alive = std::make_shared<std::atomic<bool>>(true);
    {
      std::lock_guard<std::mutex> lock(data_->mutex);
      data_->subscribers.push_back(sub);
    }
    runtimeSubs_->add(data_, sub);

    auto data = data_;
    auto runtimeSubs = runtimeSubs_;
    return Function::createFromHostFunction(
        rt,
        PropNameID::forAscii(rt, "unsubscribe"),
        0,
        [data, sub, runtimeSubs](Runtime&, const Value&, const Value*, size_t) {
          sub->alive->store(false);
          {
            std::lock_guard<std::mutex> lock(data->mutex);
            auto& subs = data->subscribers;
            for (size_t i = 0; i < subs.size(); ++i) {
              if (subs[i]->id == sub->id) {
                subs.erase(subs.begin() + i);
                break;
              }
            }
          }
          runtimeSubs->remove(sub->id);
          return Value::undefined();
        });
  }

  Value jsSubscribe(Runtime& rt, const Value* args, size_t count) {
    if (count < 2) throw JSError(rt, "subscribe(key, cb) requires 2 arguments");
    return subscribeImpl(
        rt, args[0].asString(rt).utf8(rt), false, false, Path{}, args[1]);
  }

  Value jsSubscribeIn(Runtime& rt, const Value* args, size_t count) {
    if (count < 3)
      throw JSError(rt, "subscribeIn(key, path, cb) requires 3 arguments");
    return subscribeImpl(
        rt,
        args[0].asString(rt).utf8(rt),
        false,
        true,
        readPath(rt, args[1]),
        args[2]);
  }

  Value jsWatch(Runtime& rt, const Value* args, size_t count) {
    if (count < 1) throw JSError(rt, "watch(cb) requires a callback");
    return subscribeImpl(rt, std::string(), true, false, Path{}, args[0]);
  }

  std::shared_ptr<StoreData> data_;
  RuntimePoster poster_;
  std::shared_ptr<RuntimeSubscriptions> runtimeSubs_;
  std::shared_ptr<Function> classifier_;
  std::shared_ptr<BatchContext> batch_;
};

} // namespace

std::function<void(Runtime&)> installSharedStore(
    Runtime& rt,
    RuntimePoster poster) {
  auto runtimeSubs = std::make_shared<RuntimeSubscriptions>();

  // A tiny helper that classifies a value as a "plain object" (explode into a
  // node tree) vs anything else (store whole). Built once per runtime; used by
  // set/setIn to decide how deep to decompose. Best-effort — a failure to build
  // it just means values are stored as single leaves (non-granular fallback).
  std::shared_ptr<Function> classifier;
  try {
    Value fn = rt.evaluateJavaScript(
        std::make_shared<const StringBuffer>(
            "(function(v){var p=Object.getPrototypeOf(v);"
            "return (p===Object.prototype||p===null)?1:0;})"),
        "rnworkers-classify.js");
    classifier = std::make_shared<Function>(fn.asObject(rt).asFunction(rt));
  } catch (...) {
    classifier = nullptr;
  }

  // One batch context per runtime (shared by every StoreHandle this runtime opens
  // so a single batch() can span multiple stores).
  auto batch = std::make_shared<BatchContext>();

  rt.global().setProperty(
      rt,
      "__rnworkersOpenStore",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersOpenStore"),
          1,
          [poster, runtimeSubs, classifier, batch](
              Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            std::string name =
                count > 0 && args[0].isString() ? args[0].getString(rt).utf8(rt)
                                                : std::string("default");
            auto handle = std::make_shared<StoreHandle>(
                openStore(name), poster, runtimeSubs, classifier, batch);
            return Value(handle->toObject(rt));
          }));

  rt.global().setProperty(
      rt,
      "__rnworkersDeleteStore",
      Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "__rnworkersDeleteStore"),
          1,
          [](Runtime& rt, const Value&, const Value* args, size_t count)
              -> Value {
            if (count < 1 || !args[0].isString())
              throw JSError(rt, "SharedStore.delete(name) requires a string");
            return Value(releaseStore(args[0].getString(rt).utf8(rt)));
          }));

  // Cleanup: remove every subscription this runtime made and free its callbacks.
  // Runs on the runtime's own thread before teardown (see setPreDestroy), so the
  // jsi::Functions are freed against a live runtime and no other runtime's notify
  // can reach this (soon-to-be-destroyed) runtime afterwards.
  return [runtimeSubs](Runtime&) {
    std::vector<std::pair<std::shared_ptr<StoreData>, std::shared_ptr<Subscriber>>>
        entries;
    {
      std::lock_guard<std::mutex> lock(runtimeSubs->mutex);
      entries.swap(runtimeSubs->entries);
    }
    for (auto& e : entries) {
      auto& store = e.first;
      auto& sub = e.second;
      sub->alive->store(false);
      {
        std::lock_guard<std::mutex> lock(store->mutex);
        auto& subs = store->subscribers;
        for (size_t i = 0; i < subs.size(); ++i) {
          if (subs[i]->id == sub->id) {
            subs.erase(subs.begin() + i);
            break;
          }
        }
      }
      sub->callback.reset();
    }
  };
}

} // namespace facebook::react::workers
