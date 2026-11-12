// Web-Worker conformance / behavior suite for @ammarahmed/react-native-workers.
//
// `runConformance()` runs each check independently and returns a results array.
// It never throws: every test is wrapped so a failure (or an unexpected error)
// is recorded as `{ pass: false, detail: <reason> }` instead of aborting the run.
//
// Only the INLINE worker form is exercised here (`new Worker({ inline })`), so
// the suite is self-contained and does not depend on Metro or bundled workers.

import { Worker } from '@ammarahmed/react-native-workers';
import {
  ECHO_ONCE,
  ECHO_STREAM,
  READY_AT_TOP_LEVEL,
  CHECK_CYCLE,
  CHECK_DUP_REF,
  READ_TYPED_ARRAY,
  READ_ARRAYBUFFER,
  READ_DATE,
  CHECK_NUMBER_EDGE,
  TIMER,
  MICROTASK_ORDER,
  THROW_THEN_SURVIVE,
  ECHO_ALIVE,
  COUNTER,
  REPLY_THEN_CLOSE,
} from './conformanceWorkers';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const DEFAULT_TIMEOUT = 3000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Structural equality that also treats NaN as equal to NaN. */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Attaches an onmessage collector to a worker and resolves with everything the
 * worker posts, either when it posts the `{ __done: true }` sentinel or when
 * `timeout` elapses (whichever comes first). The sentinel itself is not
 * included in the returned array.
 */
function collect(worker: Worker, timeout: number): Promise<any[]> {
  return new Promise((resolve) => {
    const out: any[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(finish, timeout);
    worker.onmessage = (e: any) => {
      if (e && e.data && e.data.__done === true) {
        finish();
        return;
      }
      out.push(e.data);
    };
  });
}

/**
 * Creates an inline worker, posts each message in `messages`, then resolves with
 * the list of messages the worker posted back (see `collect`). The worker is
 * always terminated before the promise resolves.
 */
async function runWorker(
  code: string,
  messages: any[],
  timeout: number = DEFAULT_TIMEOUT
): Promise<any[]> {
  const worker = new Worker({ inline: code });
  const collected = collect(worker, timeout);
  for (const m of messages) worker.postMessage(m);
  const result = await collected;
  worker.terminate();
  return result;
}

/** Runs one test, converting a thrown error into a failing result. */
async function runTest(
  name: string,
  fn: () => Promise<{ pass: boolean; detail: string }>
): Promise<TestResult> {
  try {
    const r = await fn();
    return { name, pass: r.pass, detail: r.detail };
  } catch (err: any) {
    return {
      name,
      pass: false,
      detail: 'threw: ' + (err && err.message ? err.message : String(err)),
    };
  }
}

const ok = (detail = 'ok') => ({ pass: true, detail });
const fail = (detail: string) => ({ pass: false, detail });

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

async function tBasicRoundtrip() {
  const sent = { a: 1, b: 'two', c: true };
  const msgs = await runWorker(ECHO_ONCE, [sent]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  return deepEqual(msgs[0], sent)
    ? ok(JSON.stringify(msgs[0]))
    : fail(`echo mismatch: ${JSON.stringify(msgs[0])}`);
}

async function tReadyBeforePost() {
  // Worker posts 'ready' at top level. Host deliberately delays attaching its
  // onmessage handler; a spec-compliant implementation buffers the message so
  // it is still delivered once a listener exists.
  const worker = new Worker({ inline: READY_AT_TOP_LEVEL });
  await delay(150);
  const msgs = await collect(worker, DEFAULT_TIMEOUT);
  worker.terminate();
  const got = msgs.some((m) => m && m.ready === true);
  return got
    ? ok('buffered ready message delivered')
    : fail(`ready not received; got ${JSON.stringify(msgs)}`);
}

async function tNestedObject() {
  const sent = {
    level1: { level2: { arr: [1, [2, 3], { x: 'y' }], flag: false } },
  };
  const msgs = await runWorker(ECHO_ONCE, [sent]);
  return msgs.length === 1 && deepEqual(msgs[0], sent)
    ? ok('nested structure preserved')
    : fail(`mismatch: ${JSON.stringify(msgs[0])}`);
}

async function tCycle() {
  const a: any = { name: 'root' };
  a.self = a;
  const msgs = await runWorker(CHECK_CYCLE, [a]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  return msgs[0].isCycle === true
    ? ok('cycle identity preserved in worker')
    : fail(`worker reported isCycle=${msgs[0].isCycle}`);
}

async function tDuplicateRef() {
  const inner = { shared: 42 };
  const sent = { x: inner, y: inner };
  const msgs = await runWorker(CHECK_DUP_REF, [sent]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  return msgs[0].sameRef === true
    ? ok('shared reference identity preserved')
    : fail(`worker reported sameRef=${msgs[0].sameRef}`);
}

async function tTypedArray() {
  const sent = new Uint8Array([1, 2, 3, 250]);
  const msgs = await runWorker(READ_TYPED_ARRAY, [sent]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  const expected = [1, 2, 3, 250];
  return deepEqual(msgs[0].bytes, expected)
    ? ok(JSON.stringify(msgs[0].bytes))
    : fail(`bytes mismatch: ${JSON.stringify(msgs[0].bytes)}`);
}

async function tArrayBuffer() {
  const buf = new ArrayBuffer(8);
  const msgs = await runWorker(READ_ARRAYBUFFER, [buf]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  return msgs[0].byteLength === 8
    ? ok('byteLength = 8')
    : fail(`byteLength was ${msgs[0].byteLength}`);
}

async function tDate() {
  const sent = new Date('2020-01-02T03:04:05.678Z');
  const msgs = await runWorker(READ_DATE, [sent]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  if (msgs[0].isDate !== true) {
    return fail('value did not arrive as a Date instance');
  }
  return msgs[0].time === sent.getTime()
    ? ok('getTime() preserved')
    : fail(`getTime mismatch: ${msgs[0].time} vs ${sent.getTime()}`);
}

async function tNumberEdge() {
  const sent = { nan: NaN, ninf: -Infinity, negzero: -0 };
  const msgs = await runWorker(CHECK_NUMBER_EDGE, [sent]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  const r = msgs[0];
  if (r.nanIsNaN !== true) return fail('NaN not preserved');
  if (r.ninfIsNegInf !== true) return fail('-Infinity not preserved');
  if (r.negZeroIsNegZero !== true) return fail('-0 not preserved');
  return ok('NaN, -Infinity, -0 all preserved');
}

async function tFifoOrder() {
  const sent = [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }];
  const msgs = await runWorker(ECHO_STREAM, [...sent, { done: true }]);
  if (msgs.length !== 5) return fail(`expected 5 echoes, got ${msgs.length}`);
  for (let i = 0; i < 5; i++) {
    if (msgs[i].i !== i) {
      return fail(`out of order at ${i}: got ${msgs[i].i}`);
    }
  }
  return ok('5 messages echoed in FIFO order');
}

async function tTimer() {
  const msgs = await runWorker(TIMER, [{ go: true }]);
  return msgs.length === 1 && msgs[0].fired === true
    ? ok('setTimeout(50) delivered')
    : fail(`unexpected result: ${JSON.stringify(msgs)}`);
}

async function tMicrotaskOrder() {
  const msgs = await runWorker(MICROTASK_ORDER, [{ go: true }]);
  if (msgs.length !== 1) return fail(`expected 1 message, got ${msgs.length}`);
  return deepEqual(msgs[0].order, ['micro', 'macro'])
    ? ok("order = ['micro','macro']")
    : fail(`order was ${JSON.stringify(msgs[0].order)}`);
}

async function tWorkerError() {
  const worker = new Worker({ inline: THROW_THEN_SURVIVE });
  const errors: any[] = [];
  const messages: any[] = [];
  worker.onerror = (e: any) => errors.push(e);
  worker.onmessage = (e: any) => messages.push(e.data);

  worker.postMessage({ cmd: 'throw' });
  await delay(250);
  // Worker must still be alive and able to answer a follow-up message.
  worker.postMessage({ cmd: 'ping' });
  await delay(350);
  worker.terminate();

  if (errors.length === 0) return fail('onerror never fired');
  const msg = String(errors[0] && errors[0].message);
  if (msg.indexOf('kaboom') === -1) {
    return fail(`onerror.message did not contain thrown text: "${msg}"`);
  }
  const survived = messages.some((m) => m && m.pong === true);
  if (!survived) return fail('worker did not answer after throwing');
  return ok('onerror reported the throw and worker survived');
}

async function tDataCloneFunction() {
  const worker = new Worker({ inline: ECHO_ALIVE });
  let threw = false;
  let detail = '';
  try {
    worker.postMessage(() => {});
  } catch (err: any) {
    threw = true;
    detail = err && err.message ? err.message : String(err);
  }
  worker.terminate();
  return threw
    ? ok(`postMessage(function) threw: ${detail}`)
    : fail('postMessage(function) did not throw');
}

async function tTerminate() {
  const worker = new Worker({ inline: ECHO_ALIVE });
  const messages: any[] = [];
  worker.onmessage = (e: any) => messages.push(e.data);

  worker.postMessage({ n: 1 });
  await delay(250);
  const before = messages.length;
  if (before === 0) return fail('worker never replied before terminate');

  worker.terminate();
  worker.postMessage({ n: 2 });
  await delay(300);

  return messages.length === before
    ? ok('no messages received after terminate()')
    : fail(`received ${messages.length - before} message(s) post-terminate`);
}

async function tIsolation() {
  const a = new Worker({ inline: COUNTER });
  const b = new Worker({ inline: COUNTER });
  const aMsgs: any[] = [];
  const bMsgs: any[] = [];
  a.onmessage = (e: any) => aMsgs.push(e.data.n);
  b.onmessage = (e: any) => bMsgs.push(e.data.n);

  a.postMessage({});
  a.postMessage({});
  b.postMessage({});
  await delay(350);
  a.terminate();
  b.terminate();

  // A was messaged twice -> [1, 2]; B once -> [1]. Shared state would leak.
  if (!deepEqual(aMsgs, [1, 2])) {
    return fail(`worker A counter = ${JSON.stringify(aMsgs)} (expected [1,2])`);
  }
  if (!deepEqual(bMsgs, [1])) {
    return fail(`worker B counter = ${JSON.stringify(bMsgs)} (expected [1])`);
  }
  return ok('workers kept independent global state');
}

async function tAddEventListener() {
  const worker = new Worker({ inline: ECHO_ALIVE });
  const received: any[] = [];
  const cb = (e: any) => received.push(e.data);

  worker.addEventListener('message', cb);
  worker.postMessage({ v: 1 });
  await delay(250);
  if (received.length === 0) {
    worker.terminate();
    return fail("addEventListener('message') never fired");
  }

  const countAfterAdd = received.length;
  worker.removeEventListener('message', cb);
  worker.postMessage({ v: 2 });
  await delay(250);
  worker.terminate();

  return received.length === countAfterAdd
    ? ok('listener fired then stopped after removeEventListener')
    : fail(`listener still firing after removal (${received.length} total)`);
}

async function tClose() {
  const worker = new Worker({ inline: REPLY_THEN_CLOSE });
  const messages: any[] = [];
  worker.onmessage = (e: any) => messages.push(e.data);
  worker.postMessage({ go: true });
  await delay(300);
  worker.terminate();
  return messages.some((m) => m && m.closing === true)
    ? ok('reply arrived before self.close()')
    : fail(`no reply before close; got ${JSON.stringify(messages)}`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runConformance(): Promise<TestResult[]> {
  const cases: Array<
    [string, () => Promise<{ pass: boolean; detail: string }>]
  > = [
    ['basic-roundtrip', tBasicRoundtrip],
    ['ready-before-post', tReadyBeforePost],
    ['nested-object', tNestedObject],
    ['cycle', tCycle],
    ['duplicate-ref', tDuplicateRef],
    ['typed-array', tTypedArray],
    ['arraybuffer', tArrayBuffer],
    ['date', tDate],
    ['number-edge', tNumberEdge],
    ['fifo-order', tFifoOrder],
    ['timer', tTimer],
    ['microtask-order', tMicrotaskOrder],
    ['worker-error', tWorkerError],
    ['dataclone-function', tDataCloneFunction],
    ['terminate', tTerminate],
    ['isolation', tIsolation],
    ['addEventListener', tAddEventListener],
    ['close', tClose],
  ];

  const results: TestResult[] = [];
  // Run sequentially so at most a couple of workers exist at a time and the
  // per-test timeouts don't compound under load.
  for (const [name, fn] of cases) {
    results.push(await runTest(name, fn));
  }
  return results;
}
