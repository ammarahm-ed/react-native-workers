// Worker source strings for the conformance suite (example/src/conformance.ts).
//
// Every worker communicates back to the host by calling `self.postMessage(...)`.
// A message of the exact shape `{ __done: true }` is treated by the host's
// `runWorker` helper as a sentinel meaning "no more messages are coming" so the
// promise can resolve immediately instead of waiting for the timeout.
//
// These are intentionally kept as plain ES5-ish scripts: they run inside the
// worker's WorkerGlobalScope, not through the app's Babel/TypeScript pipeline.

/** Echoes `e.data` back once, then signals done. */
export const ECHO_ONCE = `
  self.onmessage = function (e) {
    self.postMessage(e.data);
    self.postMessage({ __done: true });
  };
`;

/** Echoes every message; a message with { done: true } ends the stream. */
export const ECHO_STREAM = `
  self.onmessage = function (e) {
    if (e.data && e.data.done === true) {
      self.postMessage({ __done: true });
      return;
    }
    self.postMessage(e.data);
  };
`;

/** Posts a 'ready' message at top level, before the host attaches onmessage. */
export const READY_AT_TOP_LEVEL = `
  self.postMessage({ ready: true });
  self.postMessage({ __done: true });
`;

/** Reports whether the received value is self-referential (a cycle). */
export const CHECK_CYCLE = `
  self.onmessage = function (e) {
    self.postMessage({ isCycle: e.data.self === e.data });
    self.postMessage({ __done: true });
  };
`;

/** Reports whether two sibling properties preserved shared identity. */
export const CHECK_DUP_REF = `
  self.onmessage = function (e) {
    self.postMessage({ sameRef: e.data.x === e.data.y });
    self.postMessage({ __done: true });
  };
`;

/** Reads a typed array's bytes and posts them back as a plain array. */
export const READ_TYPED_ARRAY = `
  self.onmessage = function (e) {
    var bytes = [];
    for (var i = 0; i < e.data.length; i++) bytes.push(e.data[i]);
    self.postMessage({ bytes: bytes });
    self.postMessage({ __done: true });
  };
`;

/** Reports the byteLength of a received ArrayBuffer. */
export const READ_ARRAYBUFFER = `
  self.onmessage = function (e) {
    self.postMessage({ byteLength: e.data.byteLength });
    self.postMessage({ __done: true });
  };
`;

/** Reports getTime() of a received Date. */
export const READ_DATE = `
  self.onmessage = function (e) {
    self.postMessage({
      isDate: e.data instanceof Date,
      time: e.data && typeof e.data.getTime === 'function' ? e.data.getTime() : null
    });
    self.postMessage({ __done: true });
  };
`;

/** Reports how special numeric values survived the round-trip. */
export const CHECK_NUMBER_EDGE = `
  self.onmessage = function (e) {
    self.postMessage({
      nanIsNaN: Number.isNaN(e.data.nan),
      ninfIsNegInf: e.data.ninf === -Infinity,
      negZeroIsNegZero: Object.is(e.data.negzero, -0)
    });
    self.postMessage({ __done: true });
  };
`;

/** Posts after a 50ms timer to prove setTimeout works inside the worker. */
export const TIMER = `
  self.onmessage = function () {
    setTimeout(function () {
      self.postMessage({ fired: true });
      self.postMessage({ __done: true });
    }, 50);
  };
`;

/** Records ordering of a microtask vs a macrotask, then reports it. */
export const MICROTASK_ORDER = `
  self.onmessage = function () {
    var order = [];
    Promise.resolve().then(function () { order.push('micro'); });
    setTimeout(function () {
      order.push('macro');
      self.postMessage({ order: order });
      self.postMessage({ __done: true });
    }, 0);
  };
`;

/** Throws on { cmd: 'throw' }; replies { pong: true } on { cmd: 'ping' }. */
export const THROW_THEN_SURVIVE = `
  self.onmessage = function (e) {
    if (e.data && e.data.cmd === 'throw') {
      throw new Error('kaboom in worker');
    }
    if (e.data && e.data.cmd === 'ping') {
      self.postMessage({ pong: true });
    }
  };
`;

/** Echoes each message wrapped so the host can see what it received. */
export const ECHO_ALIVE = `
  self.onmessage = function (e) {
    self.postMessage({ echo: e.data });
  };
`;

/** Maintains a private counter; each message bumps and reports it. */
export const COUNTER = `
  var n = 0;
  self.onmessage = function () {
    n++;
    self.postMessage({ n: n });
  };
`;

/** Replies, then closes itself. */
export const REPLY_THEN_CLOSE = `
  self.onmessage = function () {
    self.postMessage({ closing: true });
    self.close();
  };
`;
