#pragma once

namespace facebook::react::workers {

// JS evaluated inside every worker runtime BEFORE the user bundle. It builds the
// WorkerGlobalScope surface (self, postMessage, onmessage, addEventListener,
// close, console, timers, MessageEvent/ErrorEvent) on top of the low-level host
// functions installed by WorkerGlobalScope.cpp:
//   __workerPostMessage(data, transferList)
//   __workerClose()
//   __workerLog(level, text)
//   __workerSetTimer(callback, ms, repeat) -> id
//   __workerClearTimer(id)
// and exposes the callbacks the native side invokes:
//   globalThis.__rnworkersDispatchMessage(data)
//   globalThis.__rnworkersDispatchError(errorLike)
constexpr const char* kWorkerPrelude = R"JS(
(function () {
  'use strict';
  var g = globalThis;

  // A worker runtime has no batched bridge — TurboModules are reached through
  // the module proxy directly. RN's setUpBatchedBridge checks exactly this flag
  // (`if (!(global.RN$Bridgeless === true))`) and otherwise wires up the legacy
  // bridge, whose natives do not exist here: any worker importing a library
  // that pulls in RN's environment bootstrap then died with
  // "TypeError: undefined is not a function" inside
  // setUpDefaultReactNativeEnvironment. Declaring what is already true fixes it.
  g.RN$Bridgeless = true;

  // The bridgeless path then calls global.RN$registerCallableModule, which the
  // host installs from native and a worker does not have. Callable modules are
  // how NATIVE calls into JS by module name; nothing does that in a worker, so
  // recording the registrations is enough to satisfy RN's bootstrap. Keeping
  // them addressable also means a caller could invoke one if we ever need it.
  var callableModules = Object.create(null);
  g.RN$registerCallableModule = function (name, moduleOrFactory) {
    callableModules[name] = moduleOrFactory;
  };
  g.__rnworkersGetCallableModule = function (name) {
    var m = callableModules[name];
    return typeof m === 'function' ? m() : m;
  };

  // ---- EventTarget (minimal, spec-shaped for message/error events) ----
  function EventTargetImpl() {
    this.__listeners = Object.create(null);
  }
  EventTargetImpl.prototype.addEventListener = function (type, cb) {
    if (typeof cb !== 'function') return;
    (this.__listeners[type] || (this.__listeners[type] = [])).push(cb);
  };
  EventTargetImpl.prototype.removeEventListener = function (type, cb) {
    var arr = this.__listeners[type];
    if (!arr) return;
    var i = arr.indexOf(cb);
    if (i !== -1) arr.splice(i, 1);
  };
  EventTargetImpl.prototype.dispatchEvent = function (event) {
    var type = event && event.type;
    // Fire on* handler first (spec order: registered order; on* acts like a listener).
    var on = this['on' + type];
    if (typeof on === 'function') {
      try { on.call(this, event); } catch (e) { g.__rnworkersReportError(e); }
    }
    var arr = this.__listeners[type];
    if (arr) {
      var copy = arr.slice();
      for (var i = 0; i < copy.length; i++) {
        try { copy[i].call(this, event); } catch (e) { g.__rnworkersReportError(e); }
      }
    }
    return true;
  };

  // Make globalThis an EventTarget.
  var proto = EventTargetImpl.prototype;
  for (var k in proto) g[k] = proto[k];
  g.__listeners = Object.create(null);

  g.self = g;
  g.location = g.location || { href: g.__rnworkersSourceURL || '' };

  function MessageEvent(type, init) {
    this.type = type;
    this.data = init ? init.data : undefined;
    this.origin = '';
    this.lastEventId = '';
  }
  function ErrorEvent(type, init) {
    init = init || {};
    this.type = type;
    this.message = init.message || '';
    this.filename = init.filename || '';
    this.lineno = init.lineno || 0;
    this.colno = init.colno || 0;
    this.error = init.error;
    this.stack = init.stack || (init.error && init.error.stack) || '';
    this.__defaultPrevented = false;
  }
  ErrorEvent.prototype.preventDefault = function () { this.__defaultPrevented = true; };
  g.MessageEvent = MessageEvent;
  g.ErrorEvent = ErrorEvent;

  // ---- messaging ----
  g.postMessage = function (data, transferOrOptions) {
    var transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : (transferOrOptions && transferOrOptions.transfer) || [];
    g.__workerPostMessage(data, transfer);
  };
  g.close = function () { g.__workerClose(); };

  // Called by native when a message arrives from the host.
  g.__rnworkersDispatchMessage = function (data) {
    g.dispatchEvent(new MessageEvent('message', { data: data }));
  };
  g.__rnworkersDispatchMessageError = function () {
    g.dispatchEvent(new MessageEvent('messageerror', {}));
  };

  // ---- error handling ----
  // Hermes Error objects have no `lineNumber`/`columnNumber` (those are
  // SpiderMonkey extensions), so the only real position information is inside
  // `stack`. Parse the topmost frame out of it, otherwise every uncaught worker
  // error is reported at 0:0 with no indication of which module threw.
  function parseTopFrame(stack) {
    if (!stack || typeof stack !== 'string') return null;
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      // Matches both "at fn (url:line:col)" and "at url:line:col".
      var m = /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(lines[i]);
      if (m) {
        return { filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) };
      }
    }
    return null;
  }
  g.__rnworkersParseTopFrame = parseTopFrame;

  g.__rnworkersReportError = function (err) {
    var stack = (err && err.stack) || '';
    var frame = parseTopFrame(stack) || {};
    var ev = new ErrorEvent('error', {
      message: (err && err.message) || String(err),
      filename:
        frame.filename || (g.location && g.location.href) || '',
      lineno: (err && err.lineNumber) || frame.lineno || 0,
      colno: (err && err.columnNumber) || frame.colno || 0,
      error: err,
    });
    ev.stack = stack;
    g.dispatchEvent(ev);
    if (!ev.__defaultPrevented) {
      // Report to the host so the parent Worker's onerror fires.
      g.__workerReportError(
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
        stack
      );
    }
  };
  // Native invokes this for uncaught errors surfaced from C++.
  g.__rnworkersDispatchError = function (message, filename, lineno, colno, stack) {
    var err = new Error(message);
    err.stack = stack;
    var ev = new ErrorEvent('error', {
      message: message, filename: filename, lineno: lineno, colno: colno, error: err,
    });
    g.dispatchEvent(ev);
    return ev.__defaultPrevented;
  };

  // ---- console ----
  function fmt(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') { out.push(a); continue; }
      // Errors must be handled before JSON.stringify: `message`/`stack` are
      // non-enumerable, so stringifying one yields a useless "{}" — which is
      // exactly what a library logging `console.error(err)` inside a worker
      // used to produce.
      if (a instanceof Error || (a && typeof a.message === 'string' && typeof a.stack === 'string')) {
        out.push(String(a.stack || (a.name + ': ' + a.message)));
        continue;
      }
      try {
        var s = JSON.stringify(a);
        // Objects with no enumerable properties (host objects, class instances
        // with only accessors) also stringify to "{}" — String() is more
        // informative than nothing.
        out.push(s === undefined || s === '{}' ? String(a) : s);
      } catch (e) { out.push(String(a)); }
    }
    return out.join(' ');
  }
  // Hermes installs its own console when the runtime is created with the
  // debugger enabled; that is the one CDP observes, so it must keep receiving
  // calls or the worker's own DevTools console stays empty. Keep a reference
  // before we shadow it and forward to both: Hermes (worker's own DevTools) and
  // the host (tagged, so worker output is visible where app logs already are).
  var nativeConsole = g.console;
  function mkLog(level) {
    return function () {
      var text = fmt(arguments);
      if (nativeConsole && typeof nativeConsole[level] === 'function') {
        try { nativeConsole[level].apply(nativeConsole, arguments); } catch (e) {}
      }
      g.__workerLog(level, text);
    };
  }
  g.console = {
    log: mkLog('log'), info: mkLog('info'), warn: mkLog('warn'),
    error: mkLog('error'), debug: mkLog('debug'), trace: mkLog('log'),
  };

  // ---- timers ----
  g.setTimeout = function (cb, ms) {
    var extra = Array.prototype.slice.call(arguments, 2);
    var fn = extra.length ? function () { cb.apply(null, extra); } : cb;
    return g.__workerSetTimer(fn, ms || 0, false);
  };
  g.setInterval = function (cb, ms) {
    var extra = Array.prototype.slice.call(arguments, 2);
    var fn = extra.length ? function () { cb.apply(null, extra); } : cb;
    return g.__workerSetTimer(fn, ms || 0, true);
  };
  g.clearTimeout = function (id) { g.__workerClearTimer(id); };
  g.clearInterval = function (id) { g.__workerClearTimer(id); };
  g.setImmediate = function (cb) {
    var extra = Array.prototype.slice.call(arguments, 1);
    var fn = extra.length ? function () { cb.apply(null, extra); } : cb;
    return g.__workerSetTimer(fn, 0, false);
  };
  g.clearImmediate = function (id) { g.__workerClearTimer(id); };
  if (typeof g.queueMicrotask !== 'function') {
    g.queueMicrotask = function (cb) { Promise.resolve().then(cb); };
  }

  // importScripts is not supported (workers use bundled imports).
  g.importScripts = function () {
    throw new Error(
      "importScripts is not supported in react-native-workers; use ES imports " +
      "(resolved at bundle time) instead."
    );
  };

  // ---- nested workers ----
  // A worker can spawn child workers. This works because Phase 3 gives each
  // runtime its own ReactNativeWorkers native module instance bound to THIS
  // worker's CallInvoker, so child events are delivered back into this runtime.
  var childMod = null;
  var childReady = false;
  var childRegistry = Object.create(null);

  // Access a native TurboModule from within the worker. Bridgeless installs
  // global.nativeModuleProxy (a host object); the classic path installs
  // global.__turboModuleProxy (a function). Support both.
  g.__rnworkersGetModule = function (name) {
    if (typeof g.__turboModuleProxy === 'function') return g.__turboModuleProxy(name);
    if (g.nativeModuleProxy) return g.nativeModuleProxy[name];
    return null;
  };

  function ensureChildClient() {
    if (childReady) return childMod;
    childMod = g.__rnworkersGetModule('ReactNativeWorkers');
    if (!childMod) return null;
    childMod.install();
    g.__rnworkersDeliver = function (id, type, payload) {
      var d = childRegistry[id];
      if (d) d(type, payload);
    };
    childReady = true;
    return childMod;
  }

  function resolveChildSource(source) {
    if (source && typeof source === 'object' && 'inline' in source) {
      return { kind: 'inline', value: source.inline, sourceUrl: source.sourceUrl || 'worker://inline' };
    }
    var id = typeof source === 'string' ? source : (source && source.id);
    // Nested bundled-worker loading (dev URL / release asset) is delegated to
    // the native loader; inline children are fully supported today.
    var base = (g.location && g.location.href) || '';
    var slash = base.lastIndexOf('/');
    var dir = slash >= 0 ? base.slice(0, slash + 1) : '';
    return { kind: 'url', value: dir + id + '.bundle', sourceUrl: id };
  }

  function ChildWorker(source, options) {
    options = options || {};
    var m = ensureChildClient();
    if (!m) throw new Error('Nested workers require native module access in this worker');
    this._listeners = Object.create(null);
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._terminated = false;
    this._pending = [];
    this._id = null;
    var desc = resolveChildSource(source);
    this._id = m.createWorker(desc.kind, desc.value, desc.sourceUrl, options.name || '', !!options.nativeModules);
    var self_ = this;
    childRegistry[this._id] = function (type, payload) { self_.__deliver(type, payload); };
    for (var i = 0; i < this._pending.length; i++) {
      g.__RNWorkersPostMessage(this._id, this._pending[i].data, this._pending[i].transfer);
    }
    this._pending = [];
  }
  ChildWorker.prototype.postMessage = function (data, transfer) {
    if (this._terminated) return;
    if (this._id == null) { this._pending.push({ data: data, transfer: transfer || [] }); return; }
    g.__RNWorkersPostMessage(this._id, data, transfer || []);
  };
  ChildWorker.prototype.terminate = function () {
    if (this._terminated) return;
    this._terminated = true;
    if (this._id != null) { delete childRegistry[this._id]; ensureChildClient().terminate(this._id); }
  };
  ChildWorker.prototype.addEventListener = function (type, cb) {
    if (typeof cb !== 'function') return;
    (this._listeners[type] || (this._listeners[type] = [])).push(cb);
  };
  ChildWorker.prototype.removeEventListener = function (type, cb) {
    var arr = this._listeners[type]; if (!arr) return;
    var i = arr.indexOf(cb); if (i !== -1) arr.splice(i, 1);
  };
  ChildWorker.prototype.dispatchEvent = function (ev) { this.__fire(ev.type, ev); return true; };
  ChildWorker.prototype.__fire = function (type, ev) {
    var on = this['on' + type];
    if (typeof on === 'function') on.call(this, ev);
    var arr = this._listeners[type];
    if (arr) { var c = arr.slice(); for (var i = 0; i < c.length; i++) c[i].call(this, ev); }
  };
  ChildWorker.prototype.__deliver = function (type, payload) {
    if (type === 'message') {
      // Bridge traffic ('__rnwb' === 1) is multiplexed over the same message
      // channel; a child announces itself with a `hello` envelope at startup.
      // It must NOT surface on the user's child.onmessage — otherwise the first
      // thing a parent sees from a fresh child is the bridge hello, not the
      // child's real reply. Mirror the host wrappers (src/Worker*.ts), which
      // intercept it the same way. Nested worker↔child bridge RPC is not a
      // feature yet, so there is nothing to route it to — dropping is correct.
      if (payload && payload['__rnwb'] === 1) return;
      this.__fire('message', { type: 'message', data: payload });
    }
    else if (type === 'error') this.__fire('error', payload && (payload.type = 'error', payload) || { type: 'error' });
    else if (type === 'messageerror') this.__fire('messageerror', { type: 'messageerror' });
  };

  g.Worker = ChildWorker;

  // ---- SharedStore (non-spec) ----
  // Cross-worker shared state with synchronized read/write + watchers, backed by
  // a C++ store. Available in workers and on the host.
  function SharedStore(name) {
    if (typeof g.__rnworkersOpenStore !== 'function') {
      throw new Error('SharedStore is not available in this runtime');
    }
    this._h = g.__rnworkersOpenStore(name || 'default');
  }
  SharedStore.prototype.get = function (k) { return this._h.get(k); };
  SharedStore.prototype.set = function (k, v) { return this._h.set(k, v); };
  SharedStore.prototype.getIn = function (k, p) { return this._h.getIn(k, p); };
  SharedStore.prototype.setIn = function (k, p, v) { return this._h.setIn(k, p, v); };
  SharedStore.prototype.merge = function (k, partial) { return this._h.merge(k, partial); };
  SharedStore.prototype.deleteIn = function (k, p) { return this._h.deleteIn(k, p); };
  SharedStore.prototype.has = function (k) { return this._h.has(k); };
  SharedStore.prototype.delete = function (k) { return this._h.delete(k); };
  SharedStore.prototype.keys = function () { return this._h.keys(); };
  SharedStore.prototype.subscribe = function (k, cb) { return this._h.subscribe(k, cb); };
  SharedStore.prototype.subscribeIn = function (k, p, cb) { return this._h.subscribeIn(k, p, cb); };
  SharedStore.prototype.watch = function (cb) { return this._h.watch(cb); };
  SharedStore.prototype.batch = function (fn) { return this._h.batch(fn); };
  SharedStore.prototype.batchBegin = function () { return this._h.batchBegin(); };
  SharedStore.prototype.batchEnd = function () { return this._h.batchEnd(); };
  // Release a named store process-wide (see src/SharedStore.native.ts).
  SharedStore.delete = function (name) {
    return typeof g.__rnworkersDeleteStore === 'function'
      ? g.__rnworkersDeleteStore(name) : false;
  };
  g.SharedStore = SharedStore;

  // ---- SharedValue (non-spec) ----
  // A single synchronous shared cell (fast path for hot values).
  function SharedValue(name, initial) {
    if (typeof g.__rnworkersOpenSharedValue !== 'function') {
      throw new Error('SharedValue is not available in this runtime');
    }
    this._h = g.__rnworkersOpenSharedValue(name || 'default', initial);
  }
  Object.defineProperty(SharedValue.prototype, 'value', {
    get: function () { return this._h.value; },
    set: function (v) { this._h.value = v; },
  });
  SharedValue.prototype.subscribe = function (cb) { return this._h.subscribe(cb); };
  // Release a named cell process-wide (see src/SharedValue.native.ts).
  SharedValue.delete = function (name) {
    return typeof g.__rnworkersDeleteSharedValue === 'function'
      ? g.__rnworkersDeleteSharedValue(name) : false;
  };
  g.SharedValue = SharedValue;

  // ---- SharedBuffer (non-spec) ----
  // Raw shared memory + a named cross-runtime lock.
  function SharedBuffer(name, byteLength) {
    if (typeof g.__rnworkersOpenSharedBuffer !== 'function') {
      throw new Error('SharedBuffer is not available in this runtime');
    }
    this.arrayBuffer = g.__rnworkersOpenSharedBuffer(name, byteLength);
    this.byteLength = this.arrayBuffer.byteLength;
    this._lock = g.__rnworkersOpenSharedLock(name);
  }
  SharedBuffer.prototype.withLock = function (fn) {
    var r;
    this._lock.withLock(function () { r = fn(); });
    return r;
  };
  // Release a named buffer process-wide (see src/SharedBuffer.native.ts).
  SharedBuffer.delete = function (name) {
    return typeof g.__rnworkersDeleteSharedBuffer === 'function'
      ? g.__rnworkersDeleteSharedBuffer(name) : false;
  };
  g.SharedBuffer = SharedBuffer;

  // ---- Native device events (NativeEventEmitter) ----
  // C++ (Cxx) TurboModules resolved in this worker emit via
  // TurboModule::emitDeviceEvent, which reads THIS runtime's
  // global.__rctDeviceEventEmitter (their jsInvoker is the worker's). Java/ObjC
  // modules emit on the HOST runtime instead, so the host forwards those events
  // here (opt-in) via g.__rnworkersDispatchDeviceEvent.
  var deviceListeners = Object.create(null);
  var deviceInterestSent = false;
  function ensureDeviceInterest() {
    if (deviceInterestSent) return;
    deviceInterestSent = true;
    if (typeof g.__workerEnableDeviceEvents === 'function') g.__workerEnableDeviceEvents();
  }
  var RCTDeviceEventEmitter = {
    emit: function (type) {
      var args = Array.prototype.slice.call(arguments, 1);
      var arr = deviceListeners[type];
      if (arr) {
        var copy = arr.slice();
        for (var i = 0; i < copy.length; i++) {
          try { copy[i].listener.apply(copy[i].context, args); }
          catch (e) { g.__rnworkersReportError(e); }
        }
      }
    },
    addListener: function (type, listener, context) {
      ensureDeviceInterest();
      var arr = deviceListeners[type] || (deviceListeners[type] = []);
      var sub = {
        listener: listener,
        context: context,
        remove: function () {
          var a = deviceListeners[type]; if (!a) return;
          var i = a.indexOf(sub); if (i !== -1) a.splice(i, 1);
        },
      };
      arr.push(sub);
      return sub;
    },
    removeAllListeners: function (type) {
      if (type == null) deviceListeners = Object.create(null);
      else delete deviceListeners[type];
    },
    listenerCount: function (type) { var a = deviceListeners[type]; return a ? a.length : 0; },
  };
  // `__rctDeviceEventEmitter` is a CONTESTED global. RN's own
  // Libraries/EventEmitter/RCTDeviceEventEmitter.js ends its module body with
  // the very same `Object.defineProperty(global, '__rctDeviceEventEmitter', …)`,
  // installing a real `RCTDeviceEventEmitterImpl extends EventEmitter`. Whenever
  // a worker bundle pulls that module in (importing almost anything that touches
  // NativeEventEmitter does), it replaces the object below.
  //
  // The two are NOT interchangeable: RN's class keeps its listeners in a Babel
  // loose-mode private field, so calling its `emit` with any other receiver
  // fails `hasOwnProperty(this, _registry)` and throws "attempted to use private
  // field on non-instance". Capturing either object in a closure and later
  // invoking the *other* object's method through it is therefore a crash.
  //
  // So: never capture. Resolve the emitter from the global at call time and
  // always invoke it as a method, so `this` is whichever object currently owns
  // the global. The fallback below is `this`-independent (it closes over
  // `deviceListeners`), so it stays correct either way.
  Object.defineProperty(g, '__rctDeviceEventEmitter', {
    configurable: true, writable: true, value: RCTDeviceEventEmitter,
  });

  // Belt and braces for the above: native callers are *supposed* to invoke
  // `emit` as a method (RN's own TurboModule::emitDeviceEvent uses
  // callWithThis), but a receiver-less `emit.call(rt, args…)` anywhere in the
  // stack lands on RN's class with `this === undefined` and throws. Give the
  // emitter an OWN `emit` that shadows the prototype method and closes over the
  // instance, so the receiver stops mattering for every caller at once.
  // Idempotent and only ever applied to a foreign emitter (our fallback object
  // is already `this`-independent).
  function hardenDeviceEmitter(em) {
    if (!em || em === RCTDeviceEventEmitter) return em;
    if (Object.prototype.hasOwnProperty.call(em, '__rnworkersBoundEmit')) return em;
    var proto = em.emit;
    if (typeof proto !== 'function') return em;
    try {
      Object.defineProperty(em, 'emit', {
        configurable: true, writable: true,
        value: function () { return proto.apply(em, arguments); },
      });
      Object.defineProperty(em, '__rnworkersBoundEmit', { value: true });
    } catch (e) {}
    return em;
  }
  // Called from native once worker code has been evaluated, i.e. after RN's
  // RCTDeviceEventEmitter module (if imported) has claimed the global.
  g.__rnworkersHardenDeviceEmitter = function () {
    hardenDeviceEmitter(g.__rctDeviceEventEmitter);
  };

  function currentDeviceEmitter() {
    var em = g.__rctDeviceEventEmitter;
    if (!em || typeof em.emit !== 'function') return RCTDeviceEventEmitter;
    if (em !== RCTDeviceEventEmitter) {
      ensureDeviceInterest();
      // Also covers emitters installed by a lazily-required module, after the
      // post-eval hardening pass has already run.
      hardenDeviceEmitter(em);
    }
    return em;
  }
  g.__rnworkersDeviceEmitter = currentDeviceEmitter;



  // Host delivers Java/ObjC device events here as [type, ...args].
  g.__rnworkersDispatchDeviceEvent = function (arr) {
    if (!arr || !arr.length) return;
    var em = currentDeviceEmitter();
    // Method call: `this` is the object that owns `emit`, never a foreign one.
    em.emit.apply(em, arr);
  };

  // NativeEventEmitter — a worker-friendly subset compatible with RN's API.
  function NativeEventEmitter(nativeModule) { this._nativeModule = nativeModule; }
  NativeEventEmitter.prototype.addListener = function (eventType, listener, context) {
    var mod = this._nativeModule;
    if (mod && typeof mod.addListener === 'function') mod.addListener(eventType);
    ensureDeviceInterest();
    var em = currentDeviceEmitter();
    var sub = em.addListener(eventType, listener, context);
    var origRemove = sub.remove;
    sub.remove = function () {
      if (mod && typeof mod.removeListeners === 'function') mod.removeListeners(1);
      origRemove();
    };
    return sub;
  };
  NativeEventEmitter.prototype.removeAllListeners = function (eventType) {
    var em = currentDeviceEmitter();
    if (typeof em.removeAllListeners === 'function') em.removeAllListeners(eventType);
  };
  NativeEventEmitter.prototype.emit = function () {
    g.__rctDeviceEventEmitter.emit.apply(g.__rctDeviceEventEmitter, arguments);
  };
  NativeEventEmitter.prototype.listenerCount = function (eventType) {
    return g.__rctDeviceEventEmitter.listenerCount(eventType);
  };
  g.NativeEventEmitter = NativeEventEmitter;

  // ---- JSModule bridge: two-way typed RPC with the host ----
  // Hand-written mirror of src/bridge.ts (keep the wire protocol in sync).
  (function () {
    var BRIDGE = '__rnwb';
    var modules = {};       // name -> impl
    var knownRemote = {};   // name -> true (host module announced)
    var readyWaiters = {};  // name -> [resolve]
    var pending = {};       // cid -> {resolve,reject,timer}
    var queued = {};        // name -> [callMsg] for a not-yet-registered local module
    var listeners = {};     // "mod:ev" -> [cb]
    var cidSeq = 1;

    function post(k, extra) { extra[BRIDGE] = 1; extra.k = k; g.postMessage(extra); }
    function errToWire(e) { return { message: (e && e.message) || String(e), name: e && e.name }; }
    function wireToErr(w) { var e = new Error((w && w.message) || 'bridge call failed'); if (w && w.name) e.name = w.name; return e; }

    function resolveReady(name) {
      var ws = readyWaiters[name];
      if (ws) { delete readyWaiters[name]; for (var i = 0; i < ws.length; i++) ws[i](); }
    }
    function ready(name, timeoutMs) {
      if (knownRemote[name]) return Promise.resolve();
      timeoutMs = timeoutMs || 15000;
      return new Promise(function (resolve, reject) {
        var arr = readyWaiters[name] || (readyWaiters[name] = []);
        var timer = setTimeout(function () {
          var i = arr.indexOf(wrapped); if (i !== -1) arr.splice(i, 1);
          reject(new Error('module "' + name + '" not ready after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        function wrapped() { clearTimeout(timer); resolve(); }
        arr.push(wrapped);
      });
    }
    function invokeLocal(m) {
      var impl = modules[m.mod];
      if (!impl) { (queued[m.mod] || (queued[m.mod] = [])).push(m); return; }
      var fn = impl[m.fn];
      if (typeof fn !== 'function') {
        if (m.cid != null) post('res', { cid: m.cid, ok: false, error: { message: 'no method "' + m.fn + '" on module "' + m.mod + '"' } });
        return;
      }
      Promise.resolve().then(function () { return fn.apply(impl, m.args || []); })
        .then(function (value) { if (m.cid != null) post('res', { cid: m.cid, ok: true, value: value }); })
        .catch(function (err) { if (m.cid != null) post('res', { cid: m.cid, ok: false, error: errToWire(err) }); });
    }
    function handleIncoming(msg) {
      if (!msg || msg[BRIDGE] !== 1) return false;
      if (msg.k === 'hello') { for (var mod in modules) if (Object.prototype.hasOwnProperty.call(modules, mod)) post('reg', { mod: mod }); }
      else if (msg.k === 'reg') { knownRemote[msg.mod] = true; resolveReady(msg.mod); }
      else if (msg.k === 'call') { invokeLocal(msg); }
      else if (msg.k === 'res') {
        var p = pending[msg.cid];
        if (p) { delete pending[msg.cid]; clearTimeout(p.timer); if (msg.ok) p.resolve(msg.value); else p.reject(wireToErr(msg.error)); }
      } else if (msg.k === 'evt') {
        var set = listeners[msg.mod + ':' + msg.ev];
        if (set) { var c = set.slice(); for (var i = 0; i < c.length; i++) c[i].apply(null, msg.args || []); }
      }
      return true;
    }
    function callRemote(name, fn, args, timeoutMs) {
      timeoutMs = timeoutMs || 15000;
      return new Promise(function (resolve, reject) {
        var cid = cidSeq++;
        var timer = setTimeout(function () { delete pending[cid]; reject(new Error('bridge call ' + name + '.' + fn + ' timed out (' + timeoutMs + 'ms)')); }, timeoutMs);
        pending[cid] = { resolve: resolve, reject: reject, timer: timer };
        post('call', { cid: cid, mod: name, fn: fn, args: args });
      });
    }
    function on(name, event, cb) {
      var key = name + ':' + event;
      var set = listeners[key] || (listeners[key] = []);
      set.push(cb);
      return function () { var i = set.indexOf(cb); if (i !== -1) set.splice(i, 1); };
    }
    function remote(name) {
      return new Proxy({}, {
        get: function (_t, prop) {
          if (prop === '$on') return function (ev, cb) { return on(name, ev, cb); };
          if (prop === '$ready') return function (t) { return ready(name, t); };
          if (typeof prop !== 'string') return undefined;
          return function () { return callRemote(name, prop, Array.prototype.slice.call(arguments)); };
        }
      });
    }
    function registerModule(name, impl) {
      modules[name] = impl;
      post('reg', { mod: name });
      var q = queued[name];
      if (q) { delete queued[name]; for (var i = 0; i < q.length; i++) invokeLocal(q[i]); }
      return {
        emit: function (event) { post('evt', { mod: name, ev: event, args: Array.prototype.slice.call(arguments, 1) }); },
        dispose: function () { delete modules[name]; }
      };
    }

    // Intercept bridge traffic before it reaches onmessage.
    var prevDispatch = g.__rnworkersDispatchMessage;
    g.__rnworkersDispatchMessage = function (data) {
      if (data && data[BRIDGE] === 1) { handleIncoming(data); return; }
      prevDispatch(data);
    };

    // Worker-side API: `new JSModule(name, impl)` registers a module the host can
    // call; the instance can `emit(event, ...args)` to the host.
    function JSModule(name, impl) {
      if (!(this instanceof JSModule)) return new JSModule(name, impl);
      this.name = name;
      this._h = registerModule(name, impl || {});
    }
    JSModule.prototype.emit = function (event) {
      this._h.emit.apply(this._h, [event].concat(Array.prototype.slice.call(arguments, 1)));
    };
    JSModule.prototype.dispose = function () { this._h.dispose(); };
    g.JSModule = JSModule;

    // `parent`: call host modules + register worker modules the host calls back.
    g.parent = {
      module: function (name) { return remote(name); },
      register: function (name, impl) { return registerModule(name, impl); },
      ready: function (name, t) { return ready(name, t); },
      on: function (name, ev, cb) { return on(name, ev, cb); }
    };

    // Announce ourselves so the host re-sends its registrations (mirror of
    // src/bridge.ts). Also prompts the host to reply with a `hello` of its own,
    // which is what lets a reconnecting host handle recover our modules.
    post('hello', {});
  })();

  // ---- reactive() + defineModule() (mirror of src/reactive.ts + defineModule.ts) ----
  (function () {
    var ARRAY_MUTATORS = { push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1 };
    function coerceKey(prop) { var n = Number(prop); return (Number.isInteger(n) && n >= 0 && String(n) === prop) ? n : prop; }
    function makeScheduler(store) {
      var open = false;
      return function () {
        if (open) return;
        open = true;
        store.batchBegin();
        Promise.resolve().then(function () { open = false; store.batchEnd(); });
      };
    }
    function makeNode(store, rootKey, path, schedule) {
      function child(key) {
        var v = store.getIn(rootKey, path.concat([key]));
        if (v !== null && typeof v === 'object') return makeNode(store, rootKey, path.concat([key]), schedule);
        return v;
      }
      return new Proxy(Object.create(null), {
        get: function (_t, prop) {
          if (prop === Symbol.iterator) {
            var arr = store.getIn(rootKey, path);
            if (!Array.isArray(arr)) return undefined;
            var i = 0;
            return function () { return { next: function () { return i < arr.length ? { value: child(i++), done: false } : { value: undefined, done: true }; } }; };
          }
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'toJSON' || prop === 'valueOf') return function () { return store.getIn(rootKey, path); };
          var key = coerceKey(prop);
          if (prop === 'length' || typeof key === 'number' || prop in Array.prototype) {
            var cur = store.getIn(rootKey, path);
            if (Array.isArray(cur)) {
              if (prop === 'length') return cur.length;
              if (ARRAY_MUTATORS[prop]) {
                return function () {
                  schedule();
                  var copy = cur.slice();
                  var result = copy[prop].apply(copy, arguments);
                  store.setIn(rootKey, path, copy);
                  return result;
                };
              }
              if (typeof Array.prototype[prop] === 'function' && typeof key !== 'number') {
                return function () { return cur[prop].apply(cur, arguments); };
              }
            }
          }
          return child(key);
        },
        set: function (_t, prop, value) {
          if (typeof prop === 'symbol') return true;
          schedule(); store.setIn(rootKey, path.concat([coerceKey(prop)]), value); return true;
        },
        deleteProperty: function (_t, prop) {
          if (typeof prop === 'symbol') return true;
          schedule(); store.deleteIn(rootKey, path.concat([coerceKey(prop)])); return true;
        },
        has: function (_t, prop) {
          if (typeof prop === 'symbol') return false;
          return store.getIn(rootKey, path.concat([coerceKey(prop)])) !== undefined;
        },
        ownKeys: function () {
          var v = store.getIn(rootKey, path);
          return (v != null && typeof v === 'object') ? Reflect.ownKeys(v) : [];
        },
        getOwnPropertyDescriptor: function (_t, prop) {
          if (typeof prop === 'symbol') return undefined;
          var v = store.getIn(rootKey, path.concat([coerceKey(prop)]));
          if (v === undefined) return undefined;
          return { enumerable: true, configurable: true, writable: true, value: child(coerceKey(prop)) };
        }
      });
    }
    g.reactive = function (store, rootKey) { return makeNode(store, rootKey || 'state', [], makeScheduler(store)); };

    function resolvePath(sel) {
      var path = [];
      var rec = new Proxy({}, { get: function (_t, prop) { if (typeof prop === 'string') path.push(coerceKey(prop)); return rec; } });
      sel(rec);
      return path;
    }
    g.defineModule = function (name) {
      var hostName = name + '$host';
      var stateKey = name + ':state';
      return {
        name: name,
        worker: function (impl) {
          var m = new g.JSModule(name, impl);
          var store = new g.SharedStore(stateKey);
          var hostProxy = g.parent.module(hostName);
          return {
            host: hostProxy,
            emit: function (e, p) { return m.emit(e, p); },
            on: function (e, cb) { return hostProxy.$on(e, cb); },
            state: g.reactive(store, 'state'),
            dispose: function () { m.dispose(); }
          };
        },
        host: function (worker, impl) {
          var handle = worker.registerModule(hostName, impl || {});
          var remote = worker.module(name);
          var store = new g.SharedStore(stateKey);
          var extras = {
            on: function (e, cb) { return remote.$on(e, cb); },
            emit: function (e, p) { return handle.emit(e, p); },
            state: g.reactive(store, 'state'),
            $ready: function (t) { return worker.ready(name, t); }
          };
          return new Proxy({}, { get: function (_t, prop) {
            if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(extras, prop)) return extras[prop];
            if (typeof prop === 'symbol') return undefined;
            return remote[prop];
          } });
        },
        watch: function (_state, selOrPath, cb) {
          var path = Array.isArray(selOrPath) ? selOrPath : resolvePath(selOrPath);
          var store = new g.SharedStore(stateKey);
          return store.subscribeIn('state', path, function (_r, v) { cb(v); });
        }
      };
    };
  })();
})();

// EXPERIMENTAL: `Thread` — run THIS worker's JS on another thread.
//
// There is no second runtime and no serialization: `fn` is a plain closure that
// keeps every binding it captured. What moves is which OS thread executes the
// runtime, guarded by a lock so only one thread is ever inside it (see
// cpp/runtime/WorkerJsLock.h).
//
// Gated on purpose. Until enableMultiThreadingExperimental() is called, every
// entry point throws rather than half-working.
(function () {
  var g = globalThis;
  var enabled = false;

  function ensureEnabled() {
    if (!enabled) {
      throw new Error(
        'Multi-threading is experimental and disabled. Call ' +
          'global.enableMultiThreadingExperimental() in this worker first.'
      );
    }
  }

  function WorkerThread(id, name) {
    this._id = id;
    this._disposed = false;
    this.name = name;
  }

  // Resolves on THIS worker's own thread, never on the target's — so code after
  // an `await` always continues where it started. Thread changes only ever
  // happen inside a run() callback.
  WorkerThread.prototype.run = function (fn) {
    ensureEnabled();
    if (typeof fn !== 'function') {
      throw new TypeError('Thread.run expects a function');
    }
    if (this._disposed) {
      throw new Error('Thread "' + this.name + '" has been disposed');
    }
    var id = this._id;
    return new Promise(function (resolve, reject) {
      g.__workerThreadRun(id, fn, function (message, stack, value) {
        if (message === null || message === undefined) {
          resolve(value);
          return;
        }
        var error = new Error(message);
        if (stack) error.stack = stack;
        reject(error);
      });
    });
  };

  WorkerThread.prototype.dispose = function () {
    if (this._disposed) return false;
    this._disposed = true;
    return g.__workerThreadDispose(this._id);
  };

  Object.defineProperty(WorkerThread.prototype, 'disposed', {
    get: function () {
      return this._disposed;
    }
  });

  var mainThread = null;

  g.Thread = {
    // The platform main/UI thread. Throws where UIWorker is also unavailable.
    get main() {
      ensureEnabled();
      if (!mainThread) mainThread = new WorkerThread(g.__workerThreadMain(), 'main');
      return mainThread;
    },
    // A fresh serial background thread. Tasks on it run one at a time, in order.
    create: function (name) {
      ensureEnabled();
      var threadName = typeof name === 'string' && name ? name : 'worker-thread';
      return new WorkerThread(g.__workerThreadCreate(threadName), threadName);
    },
    // Name of the thread currently executing, or '' on the worker's own thread.
    get current() {
      return g.__workerThreadCurrent();
    }
  };

  g.enableMultiThreadingExperimental = function () {
    if (typeof g.__workerThreadsEnable !== 'function') {
      throw new Error(
        'Multi-threading is not supported by this build of react-native-workers.'
      );
    }
    enabled = true;
    g.__workerThreadsEnable();
    return true;
  };
})();
)JS";

} // namespace facebook::react::workers
