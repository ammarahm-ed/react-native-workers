// Stress test for the EXPERIMENTAL `Thread` API: running this worker's own
// runtime on other threads, guarded by the runtime lock (cpp/runtime/WorkerJsLock.h).
//
// Every case here is something that would corrupt the runtime or crash the
// process if the lock were missing or taken at the wrong granularity, so this
// file is the regression suite for the feature. Each step also beacons its name
// to the host, so a hang shows up as "last step" rather than a bare timeout.
import type { ThreadApi } from '@ammarahmed/react-native-workers';

declare const self: any;
declare const Thread: ThreadApi;
declare function enableMultiThreadingExperimental(): boolean;

type Case = { n: string; p: boolean; d: string };

const results: Case[] = [];
function check(n: string, p: boolean, d: string = '') {
  results.push({ n, p, d });
}
// Worker console output does not reach Metro in this setup, so the host tracks
// the last step and reports it if we hang.
function step(s: string) {
  self.postMessage({ __step: s });
}

async function run() {
  step('gate');
  try {
    Thread.create('too-early');
    check(
      'gate: throws before enable',
      false,
      'create() succeeded while disabled'
    );
  } catch {
    check('gate: throws before enable', true);
  }

  step('enable');
  enableMultiThreadingExperimental();

  step('create');
  const bg = Thread.create('stress-bg');

  step('run: return value');
  const value = await bg.run(() => 6 * 7);
  check('run returns value', value === 42, String(value));

  step('run: Thread.current on target');
  const where = await bg.run(() => Thread.current);
  check('runs on the named thread', where === 'stress-bg', where);

  step('settles back home');
  check('settles back home', Thread.current === '', Thread.current);

  step('run: closure capture');
  let captured = 0;
  await bg.run(() => {
    captured += 5;
  });
  check('closure mutates captured state', captured === 5, String(captured));

  step('run: rejects on throw');
  try {
    await bg.run(() => {
      throw new Error('boom-from-thread');
    });
    check('rejects on throw', false, 'did not reject');
  } catch (e: any) {
    check(
      'rejects on throw',
      String(e?.message).indexOf('boom') !== -1,
      String(e?.message)
    );
  }

  step('run: main thread');
  const onMain = await Thread.main.run(() => Thread.current);
  check('main thread runs JS', onMain === 'main', onMain);

  step('serial ordering');
  const order: number[] = [];
  await Promise.all([1, 2, 3, 4, 5].map((i) => bg.run(() => order.push(i))));
  check(
    'serial FIFO per thread',
    order.join(',') === '1,2,3,4,5',
    order.join(',')
  );

  step('shared object identity');
  const marker: any = { tag: 'shared-object' };
  await bg.run(() => {
    marker.touched = true;
  });
  check('shares object identity', marker.touched === true);

  step('setTimeout from foreign thread');
  // Regression: setTimeout called from a foreign thread must wake the worker's
  // event loop even when it is parked in its untimed wait.
  const timerFired = await bg.run(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 10);
      })
  );
  check('setTimeout from foreign thread', timerFired === true);

  step('nested bg→main hop');
  // The "encode then apply" shape. The inner hop is async, so it queues and runs
  // after the outer scope releases the lock — no deadlock.
  let applied = '';
  await bg.run(() => {
    const encoded = 'payload-' + (2 + 2);
    Thread.main.run(() => {
      applied = encoded + '@' + Thread.current;
    });
  });
  await new Promise((r) => setTimeout(r, 60));
  check('nested bg→main hop', applied === 'payload-4@main', applied);

  step('deep recursion off-thread');
  // Hermes re-reads the current thread's stack bounds when execution moves
  // threads (StackOverflowGuard). If that were not so, this would segfault
  // instead of throwing — which is why it is a test and not a comment.
  try {
    await bg.run(() => {
      const recurse = (n: number): number => (n <= 0 ? 0 : 1 + recurse(n - 1));
      return recurse(100000);
    });
    check('deep recursion off-thread', false, 'no stack overflow raised');
  } catch (e: any) {
    const msg = String(e?.message || '');
    check(
      'deep recursion off-thread throws cleanly',
      /stack|Stack|overflow/.test(msg),
      msg.slice(0, 60)
    );
  }

  step('hammer');
  // Many threads, many calls, all mutating the same JS state. Each run() body is
  // atomic w.r.t. the runtime lock, so a read-modify-write inside one body must
  // never lose an update. A missing lock shows up here as a wrong total.
  const pool = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    Thread.create('hammer-' + i)
  );
  const PER_THREAD = 150;
  let counter = 0;
  const objects: any[] = [];
  await Promise.all(
    pool.map((t) =>
      Promise.all(
        new Array(PER_THREAD).fill(0).map(() =>
          t.run(() => {
            // Read-modify-write plus allocation, so the GC runs while foreign
            // threads are inside the runtime.
            const before = counter;
            objects.push({ a: new Array(24).fill(before), s: 'x'.repeat(48) });
            if (objects.length > 400) objects.length = 0;
            counter = before + 1;
          })
        )
      )
    )
  );
  const expected = pool.length * PER_THREAD;
  check(
    'no lost updates under contention',
    counter === expected,
    counter + '/' + expected
  );

  step('dispose churn');
  // Create, use and dispose targets repeatedly. Disposal must never join a
  // thread that is parked waiting for the runtime lock.
  let churnOk = true;
  let churnDetail = '';
  try {
    for (let i = 0; i < 40; i++) {
      const t = Thread.create('churn-' + i);
      await t.run(() => counter + i);
      t.dispose();
    }
  } catch (e: any) {
    churnOk = false;
    churnDetail = String(e?.message || e);
  }
  check('dispose churn survives', churnOk, churnDetail);

  step('dispose semantics');
  pool.forEach((t) => t.dispose());
  try {
    Thread.main.dispose();
    check('main cannot be disposed', false, 'dispose() succeeded');
  } catch {
    check('main cannot be disposed', true);
  }

  step('dispose');
  bg.dispose();
  check('disposed flag set', bg.disposed === true);
  try {
    await bg.run(() => 1);
    check('run after dispose throws', false, 'did not throw');
  } catch {
    check('run after dispose throws', true);
  }

  step('worker still healthy');
  const sanity = await new Promise<number>((resolve) =>
    setTimeout(() => resolve(99), 10)
  );
  check('worker healthy afterwards', sanity === 99, String(sanity));

  step('done');
}

self.onmessage = () => {
  step('onmessage');
  run()
    .then(() => self.postMessage({ results }))
    .catch((e: any) =>
      self.postMessage({ __error: String(e?.message ?? e), results })
    );
};
