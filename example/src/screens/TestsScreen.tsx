import { useEffect, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  ScrollView,
  DeviceEventEmitter,
  Platform,
} from 'react-native';
import {
  Worker,
  UIWorker,
  SharedStore,
} from '@ammarahmed/react-native-workers';
import { runConformance } from '../conformance';
import { runBridgeTests } from '../bridgeTests';
import { runPrimitivesTests } from '../primitivesTests';
import { markReady } from '../devReady';

type Result = { name: string; pass: boolean; detail: string };

// Which optional third-party libraries are linked in this build.
// The two MMKV libraries depend on incompatible MMKVCore versions, so on iOS
// only one of them can be linked at a time (see ios/Podfile).
const IS_ANDROID = Platform.OS === 'android';
const HAS_GZIP = IS_ANDROID;
const HAS_MMKV_STORAGE = IS_ANDROID;
const HAS_MMKV_NITRO = true;

// One-shot inline worker helper for the extra native/nested demos.
function once(code: string, message: any, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve) => {
    const w = new Worker({ inline: code });
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ __timeout: true });
    }, timeoutMs);
    w.onmessage = (e: any) => {
      clearTimeout(timer);
      w.terminate();
      resolve(e.data);
    };
    w.onerror = (e: any) => {
      clearTimeout(timer);
      w.terminate();
      resolve({ __error: e.message });
    };
    w.postMessage(message);
  });
}

const NATIVE_CODE = `
  self.onmessage = (e) => {
    try {
      var mod = globalThis.__rnworkersGetModule('ReactNativeWorkers');
      self.postMessage({ reachable: !!mod && typeof mod.createWorker === 'function' });
    } catch (err) {
      self.postMessage({ error: String(err && err.message || err) });
    }
  };
`;

const NESTED_CODE = `
  self.onmessage = (e) => {
    try {
      var child = new Worker({ inline: "self.onmessage = (ev) => self.postMessage(ev.data * 2);" });
      child.onmessage = (ce) => self.postMessage({ nested: ce.data });
      child.onerror = (ce) => self.postMessage({ error: ce.message });
      child.postMessage(21);
    } catch (err) {
      self.postMessage({ error: String(err && err.message || err) });
    }
  };
`;

export default function TestsScreen() {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    (async () => {
      const all: Result[] = [];
      try {
        // Legacy (old-arch) native module inside a worker, churned: start a
        // worker, do a little work, terminate — repeatedly. This is the shape
        // that used to abort natively during teardown (BlobCollector JNI ref).
        // Android-only: react-native-gzip's podspec still requires RCT-Folly and
        // so cannot link against RN 0.85 on iOS.
        if (HAS_GZIP) {
          const runOne = (id: string) =>
            new Promise<any>((resolve) => {
              const w = new Worker('../workers/gzip', { nativeModules: true });
              const t = setTimeout(() => {
                w.terminate();
                resolve({ __timeout: true });
              }, 8000);
              w.onmessage = (e: any) => {
                if (e.data && (e.data.ok !== undefined || e.data.__error)) {
                  clearTimeout(t);
                  w.terminate();
                  resolve(e.data);
                }
              };
              w.onerror = (e: any) => {
                clearTimeout(t);
                w.terminate();
                resolve({ __error: e.message });
              };
              w.postMessage('react-native-workers ' + id);
            });

          let ok = 0;
          let bad = 0;
          let last: any = null;
          const N = 20;
          for (let i = 0; i < N; i++) {
            last = await runOne(`${i}`);
            last?.ok ? ok++ : bad++;
          }
          all.push({
            name: 'gzip-legacy-module-churn',
            pass: bad === 0,
            detail:
              `${ok}/${N} ok` + (bad ? ` last=${JSON.stringify(last)}` : ''),
          });
        }

        // Phase 3: native module (TurboModule) callable inside a worker.
        const nat = await once(NATIVE_CODE, 'go');
        all.push({
          name: 'phase3-native-module',
          pass: nat?.reachable === true,
          detail: JSON.stringify(nat),
        });

        // Nested worker: a worker spawns a child worker and relays its reply.
        const nested = await once(NESTED_CODE, 'go');
        all.push({
          name: 'nested-worker',
          pass: nested?.nested === 42,
          detail: JSON.stringify(nested),
        });

        // Phase 2: bundled worker loaded from a relative path (babel-rewritten,
        // fetched from Metro in dev).
        const bundled = await new Promise<any>((resolve) => {
          try {
            const w = new Worker('../workers/double');
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 4000);
            w.onmessage = (e: any) => {
              if (e.data && e.data.doubled !== undefined) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
            w.postMessage(21);
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'phase2-bundled-worker (dev)',
          pass: bundled?.doubled === 42,
          detail: JSON.stringify(bundled),
        });

        // Third-party TurboModule (react-native-blob-util) used through its
        // normal JS wrapper inside a FILE worker: write + read a file off the UI
        // thread, then round-trip the result back to the host.
        const blobResult = await new Promise<any>((resolve) => {
          try {
            const w = new Worker('../workers/blobutil', {
              nativeModules: true,
            });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 8000);
            w.onmessage = (e: any) => {
              if (e.data && (e.data.ok !== undefined || e.data.__error)) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({
                __error: e.message,
                at: `${e.filename}:${e.lineno}:${e.colno}`,
                stack: String(e.stack ?? e.error?.stack ?? '')
                  .split('\n')
                  .slice(0, 25)
                  .join(' | '),
              });
            };
            w.postMessage('go');
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'blob-util TurboModule (file worker)',
          // Passes when the worker wrote and read back a file through the
          // library's fs API (a real TurboModule) off the UI thread.
          pass:
            blobResult?.ok === true &&
            blobResult?.readBack === 'hello from a worker thread',
          detail: JSON.stringify(blobResult),
        });

        // RN's Blob inside a worker, backed by the worker BlobModule shim and a
        // JNI-ref-free `__blobCollectorProvider`.
        const blobApi = await new Promise<any>((resolve) => {
          const w = new Worker('../workers/blob', { nativeModules: true });
          const timer = setTimeout(() => {
            w.terminate();
            resolve({ __timeout: true });
          }, 8000);
          w.onmessage = (e: any) => {
            if (e.data && (e.data.ok !== undefined || e.data.__error)) {
              clearTimeout(timer);
              w.terminate();
              resolve(e.data);
            }
          };
          w.onerror = (e: any) => {
            clearTimeout(timer);
            w.terminate();
            resolve({ __error: e.message });
          };
          w.postMessage('go');
        });
        all.push({
          name: 'Blob API (worker shim)',
          pass: blobApi?.ok === true,
          detail: JSON.stringify(blobApi),
        });

        // Pure-JSI library (react-native-mmkv-storage): its native module
        // installs C++ bindings straight onto a jsi::Runtime.
        if (HAS_MMKV_STORAGE) {
          const mmkv = await new Promise<any>((resolve) => {
            const w = new Worker('../workers/mmkv', { nativeModules: true });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 8000);
            w.onmessage = (e: any) => {
              if (e.data && (e.data.ok !== undefined || e.data.__error)) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
            w.postMessage('go');
          });
          all.push({
            name: 'mmkv-storage (pure JSI lib)',
            pass: mmkv?.ok === true,
            detail: JSON.stringify(mmkv),
          });
        }

        // react-native-mmkv (Nitro modules) — a different JSI integration again.
        if (HAS_MMKV_NITRO) {
          const mmkv2 = await new Promise<any>((resolve) => {
            const w = new Worker('../workers/mmkv2', { nativeModules: true });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 8000);
            w.onmessage = (e: any) => {
              if (e.data && (e.data.ok !== undefined || e.data.__error)) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
            w.postMessage('go');
          });
          all.push({
            name: 'react-native-mmkv (Nitro)',
            pass: mmkv2?.ok === true,
            detail: JSON.stringify(mmkv2),
          });
        }

        // SharedStore: host writes -> worker reads; worker writes -> host watcher.
        const storeResult = await new Promise<any>((resolve) => {
          try {
            const store = new SharedStore('demo');
            store.set('fromHost', { hello: 'host' });
            let watched: any = null;
            const off = store.subscribe('fromWorker', (_k, v) => {
              watched = v;
            });
            const code = `
            var s = new SharedStore('demo');
            self.onmessage = function () {
              var got = s.get('fromHost');
              s.set('fromWorker', { hello: 'worker', echo: got });
              self.postMessage({ readFromHost: got });
            };
          `;
            const w = new Worker({ inline: code });
            const timer = setTimeout(() => {
              off();
              w.terminate();
              resolve({ __timeout: true, watched });
            }, 2500);
            w.onmessage = (e: any) => {
              // Let the host-side watcher callback flush first.
              setTimeout(() => {
                clearTimeout(timer);
                off();
                w.terminate();
                resolve({ read: e.data.readFromHost, watched });
              }, 150);
            };
            w.postMessage('go');
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'shared-store (cross-worker)',
          pass:
            storeResult?.read?.hello === 'host' &&
            storeResult?.watched?.hello === 'worker',
          detail: JSON.stringify(storeResult),
        });

        // SharedStore granular: lazy get proxy + getIn + setIn (object & array) +
        // subscribeIn delta, all host-side.
        const granular = await new Promise<any>((resolve) => {
          try {
            const store = new SharedStore('granular');
            store.set('doc', {
              user: { name: 'Ada', age: 30 },
              tags: ['a', 'b'],
            });
            const doc = store.get('doc'); // lazy snapshot proxy
            const name0 = doc.user.name; // decodes only this leaf
            store.setIn('doc', ['user', 'age'], 31); // granular object update
            store.setIn('doc', ['tags', 1], 'B'); // granular array-element update
            const age = store.getIn('doc', ['user', 'age']);
            const nameUnchanged = store.getIn('doc', ['user', 'name']);
            const tag = store.getIn('doc', ['tags', 1]);
            let delta: any = null;
            const off = store.subscribeIn('doc', ['user'], (relPath, value) => {
              delta = { relPath, value };
            });
            store.setIn('doc', ['user', 'name'], 'Ada L');
            setTimeout(() => {
              off();
              resolve({ name0, age, nameUnchanged, tag, delta });
            }, 120);
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'shared-store granular (getIn/setIn/subscribeIn)',
          pass:
            granular?.name0 === 'Ada' &&
            granular?.age === 31 &&
            granular?.nameUnchanged === 'Ada' &&
            granular?.tag === 'B' &&
            granular?.delta?.relPath?.[0] === 'name' &&
            granular?.delta?.value === 'Ada L',
          detail: JSON.stringify(granular),
        });

        // SharedStore merge / deleteIn / deep array-of-objects.
        const gran2 = await (async () => {
          try {
            const store = new SharedStore('gran2');
            store.set('m', { a: 1, nested: { x: 1, y: 2 } });
            store.merge('m', { b: 2, nested: { y: 20, z: 30 } });
            const mergeOk =
              store.getIn('m', ['a']) === 1 &&
              store.getIn('m', ['b']) === 2 &&
              store.getIn('m', ['nested', 'x']) === 1 &&
              store.getIn('m', ['nested', 'y']) === 20 &&
              store.getIn('m', ['nested', 'z']) === 30;
            store.set('d', { keep: 1, drop: 2, arr: [10, 20, 30] });
            const dDrop = store.deleteIn('d', ['drop']);
            const dArr = store.deleteIn('d', ['arr', 1]); // splices
            const dNope = store.deleteIn('d', ['nope']);
            const delOk =
              dDrop === true &&
              dArr === true &&
              dNope === false &&
              store.getIn('d', ['drop']) === undefined &&
              store.getIn('d', ['keep']) === 1 &&
              store.getIn('d', ['arr']).length === 2 &&
              store.getIn('d', ['arr', 1]) === 30;
            store.set('doc', {
              items: [
                { id: 1, done: false },
                { id: 2, done: false },
              ],
            });
            store.setIn('doc', ['items', 1, 'done'], true);
            const deepOk =
              store.getIn('doc', ['items', 1, 'done']) === true &&
              store.getIn('doc', ['items', 0, 'done']) === false &&
              store.getIn('doc', ['items', 1, 'id']) === 2;
            return { mergeOk, delOk, deepOk };
          } catch (err) {
            return { __threw: String((err as any)?.message ?? err) };
          }
        })();
        all.push({
          name: 'shared-store merge/deleteIn/deep-array',
          pass: !!(gran2?.mergeOk && gran2?.delOk && gran2?.deepOk),
          detail: JSON.stringify(gran2),
        });

        // SharedStore proxy enumeration, leaf-type preservation, notify firing.
        const gran3 = await new Promise<any>((resolve) => {
          try {
            const store = new SharedStore('gran3');
            store.set('e', { a: 1, b: 2, c: 3 });
            const p = store.get('e');
            const keys = Object.keys(p).sort().join(',');
            const spread = { ...p };
            const enumOk = keys === 'a,b,c' && spread.a === 1 && spread.c === 3;
            store.set('t', {
              when: new Date(1000),
              bytes: new Uint8Array([1, 2, 3]),
            });
            const when = store.getIn('t', ['when']);
            const bytes = store.getIn('t', ['bytes']);
            const leafOk =
              when instanceof Date &&
              when.getTime() === 1000 &&
              bytes instanceof Uint8Array &&
              bytes.length === 3 &&
              bytes[2] === 3;
            store.set('s2', { v: 0 });
            let fired = 0;
            let lastV: any = null;
            const off = store.subscribe('s2', (_k, val) => {
              fired++;
              lastV = val;
            });
            let watchFired = 0;
            const offW = store.watch(() => {
              watchFired++;
            });
            store.setIn('s2', ['v'], 5);
            store.set('other', 1);
            setTimeout(() => {
              off();
              offW();
              resolve({
                enumOk,
                leafOk,
                fired,
                lastV: lastV && lastV.v,
                watchFired,
              });
            }, 140);
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'shared-store proxy/leaf-types/notify',
          pass: !!(
            gran3?.enumOk &&
            gran3?.leafOk &&
            gran3?.fired >= 1 &&
            gran3?.lastV === 5 &&
            gran3?.watchFired >= 1
          ),
          detail: JSON.stringify(gran3),
        });

        // SharedStore granular across runtimes: a worker watches a sub-path; the
        // host makes a granular change; the worker receives just the delta.
        const granularWorker = await new Promise<any>((resolve) => {
          try {
            const store = new SharedStore('granular-w');
            store.set('state', { counter: 0, meta: { label: 'init' } });
            const code = `
            var s = new SharedStore('granular-w');
            s.subscribeIn('state', ['meta'], function (relPath, value) {
              self.postMessage({ relPath: relPath, value: value });
            });
            self.postMessage({ ready: true });
          `;
            const w = new Worker({ inline: code });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 3000);
            w.onmessage = (e: any) => {
              if (e.data && e.data.ready) {
                setTimeout(
                  () => store.setIn('state', ['meta', 'label'], 'updated'),
                  50
                );
              } else if (e.data && e.data.relPath) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'shared-store subscribeIn delta (host→worker)',
          pass:
            granularWorker?.relPath?.[0] === 'label' &&
            granularWorker?.value === 'updated',
          detail: JSON.stringify(granularWorker),
        });

        // UIWorker: runtime runs on the UI/main thread (iOS + Android).
        const uiResult = await new Promise<any>((resolve) => {
          try {
            const w = new UIWorker({
              inline: `self.onmessage = function (e) { self.postMessage({ uiEcho: e.data }); };`,
            });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 2500);
            w.onmessage = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve(e.data);
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
            w.postMessage(42);
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'ui-worker (main thread)',
          // Runs on the UI thread on both iOS and Android now.
          pass: uiResult?.uiEcho === 42,
          detail: JSON.stringify(uiResult),
        });

        // Platform (ObjC/Java) native module inside a worker (SourceCode).
        const platMod = await new Promise<any>((resolve) => {
          try {
            const code = `
            self.onmessage = function () {
              var mod = globalThis.__rnworkersGetModule('SourceCode');
              var url = null;
              try {
                url = mod && (mod.getConstants ? mod.getConstants().scriptURL : mod.scriptURL);
              } catch (e) {}
              self.postMessage({ hasModule: !!mod, scriptURL: url });
            };
          `;
            // Opt into the platform (Java/ObjC) native-module bridge.
            const w = new Worker({ inline: code }, { nativeModules: true });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 2500);
            w.onmessage = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve(e.data);
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
            w.postMessage('go');
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'platform-module (worker)',
          // iOS resolves ObjC modules via the global registry; Android resolves
          // Java TurboModules via the app-registered package delegate. Both should
          // now see 'SourceCode' inside the worker.
          pass: platMod?.hasModule === true,
          detail: JSON.stringify(platMod),
        });

        // Teardown: repeatedly create + terminate nativeModules workers. Exercises
        // the pre-runtime-destroy invalidate of the per-worker platform manager;
        // a crash/hang here fails the whole suite.
        const teardown = await new Promise<any>((resolve) => {
          let done = 0;
          const total = 5;
          const guard = setTimeout(
            () => resolve({ done, __timeout: true }),
            6000
          );
          const spin = () => {
            if (done >= total) {
              clearTimeout(guard);
              resolve({ done });
              return;
            }
            const w = new Worker(
              {
                inline: `self.onmessage = function () {
                var m = globalThis.__rnworkersGetModule('SourceCode');
                self.postMessage({ ok: !!m });
              };`,
              },
              { nativeModules: true }
            );
            const t = setTimeout(() => {
              w.terminate();
              done++;
              spin();
            }, 1500);
            w.onmessage = () => {
              clearTimeout(t);
              w.terminate();
              done++;
              spin();
            };
            w.onerror = () => {
              clearTimeout(t);
              w.terminate();
              done++;
              spin();
            };
            w.postMessage('go');
          };
          spin();
        });
        all.push({
          name: 'native-module teardown (create/terminate x5)',
          pass: teardown?.done === 5,
          detail: JSON.stringify(teardown),
        });

        // NativeEventEmitter: a host device event is forwarded into the worker.
        // (Java/ObjC modules emit device events on the host runtime; the library
        // forwards them to opted-in workers. Emitting from JS exercises the same
        // shared RCTDeviceEventEmitter the native modules use.)
        const deviceEvt = await new Promise<any>((resolve) => {
          try {
            const code = `
            var em = new NativeEventEmitter();
            em.addListener('rnworkers-test-event', function (p) {
              self.postMessage({ deviceEvent: p });
            });
            self.postMessage({ ready: true });
          `;
            const w = new Worker({ inline: code });
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true });
            }, 3000);
            w.onmessage = (e: any) => {
              if (e.data && e.data.ready) {
                // Interest is registered before this 'ready' arrives; emit now.
                setTimeout(
                  () =>
                    DeviceEventEmitter.emit('rnworkers-test-event', {
                      hello: 'device',
                    }),
                  50
                );
              } else if (e.data && e.data.deviceEvent !== undefined) {
                clearTimeout(timer);
                w.terminate();
                resolve(e.data.deviceEvent);
              }
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({ __error: e.message });
            };
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'device-event (host→worker)',
          pass: deviceEvt?.hello === 'device',
          detail: JSON.stringify(deviceEvt),
        });

        // JSModule bridge suite (typed two-way RPC, events, SharedStore params).
        const bridge = await runBridgeTests();
        all.push(...bridge);

        // Shared-data primitives + defineModule (SharedValue, SharedBuffer, batch,
        // reactive, defineModule round-trip).
        const primitives = await runPrimitivesTests();
        all.push(...primitives);

        // Full behavior/conformance suite.
        const conf = await runConformance();
        all.push(...conf);

        // EXPERIMENTAL `Thread` API stress suite: runs this worker's runtime on
        // other threads under heavy contention. Generous timeout — the hammer
        // case alone is 8 threads x 150 calls.
        const threads = await new Promise<any>((resolve) => {
          try {
            const w = new Worker('../workers/threads');
            let lastStep = '(none)';
            const timer = setTimeout(() => {
              w.terminate();
              resolve({ __timeout: true, lastStep });
            }, 30000);
            w.onmessage = (e: any) => {
              if (e.data && e.data.__step) {
                lastStep = e.data.__step;
                return;
              }
              clearTimeout(timer);
              w.terminate();
              resolve(e.data);
            };
            w.onerror = (e: any) => {
              clearTimeout(timer);
              w.terminate();
              resolve({
                __error: e.message,
                at: `${e.filename}:${e.lineno}:${e.colno}`,
              });
            };
            w.postMessage('go');
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        if (threads?.results?.length) {
          all.push(
            ...threads.results.map((r: any) => ({
              name: `threads: ${r.n}`,
              pass: !!r.p,
              detail: r.d ?? '',
            }))
          );
        }
        if (threads?.__error || threads?.__timeout || threads?.__threw) {
          all.push({
            name: 'threads: suite completed',
            pass: false,
            detail: JSON.stringify(threads),
          });
        }

        // Terminate under load: hammer a worker's runtime from several threads
        // and kill it mid-flight. Teardown must unpublish the runtime and let
        // parked foreign threads unwind — never crash the process.
        const threadTeardown = await new Promise<any>((resolve) => {
          try {
            const w = new Worker({
              inline: `
                self.onmessage = () => {
                  enableMultiThreadingExperimental();
                  var ts = [0,1,2,3].map(function (i) { return Thread.create('kill-' + i); });
                  var n = 0;
                  for (var r = 0; r < 500; r++) {
                    ts.forEach(function (t) {
                      t.run(function () { n++; return n; }).catch(function () {});
                    });
                  }
                  self.postMessage({ queued: true });
                };
              `,
            });
            w.onmessage = () => {
              // Kill while hundreds of cross-thread calls are still in flight.
              setTimeout(() => {
                w.terminate();
                setTimeout(() => resolve({ ok: true }), 400);
              }, 20);
            };
            w.onerror = (e: any) => resolve({ __error: e.message });
            w.postMessage('go');
          } catch (err) {
            resolve({ __threw: String((err as any)?.message ?? err) });
          }
        });
        all.push({
          name: 'threads: terminate under load',
          pass: threadTeardown?.ok === true,
          detail: JSON.stringify(threadTeardown),
        });
      } catch (err) {
        all.push({
          name: 'harness-error',
          pass: false,
          detail: String((err as any)?.stack ?? (err as any)?.message ?? err),
        });
      }

      setResults(all);
      setRunning(false);
      markReady('tests', 'data');
      // Emit a machine-readable summary for CI / logcat verification.
      const passedCount = all.filter((r) => r.pass).length;
      const summary =
        `[RNWORKERS-RESULTS] ${passedCount}/${all.length} ` +
        JSON.stringify(
          all.map((r) => ({
            n: r.name,
            p: r.pass,
            d: r.pass ? undefined : r.detail,
          }))
        );
      // Through nativeLoggingHook like markReady(): in bridgeless dev builds
      // console.log goes to the DevTools channel and never reaches the platform
      // log, which is where CI and `simctl launch --console-pty` read from.
      const hook = (globalThis as any).nativeLoggingHook;
      if (typeof hook === 'function') hook(summary, 3);
      console.log(summary);
    })();
  }, []);

  const passed = results.filter((r) => r.pass).length;

  return (
    <View style={styles.container}>
      <Text style={styles.summary}>
        {running ? 'running…' : `${passed}/${results.length} passed`}
      </Text>
      <ScrollView style={styles.log}>
        {results.map((r, i) => (
          <View key={i} style={styles.row}>
            <Text style={[styles.badge, r.pass ? styles.pass : styles.fail]}>
              {r.pass ? 'PASS' : 'FAIL'}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.name}>{r.name}</Text>
              {!r.pass && <Text style={styles.detail}>{r.detail}</Text>}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  summary: { fontSize: 15, marginBottom: 10, color: '#555' },
  log: { flex: 1 },
  row: { flexDirection: 'row', marginBottom: 6, alignItems: 'flex-start' },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: 'white',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
    overflow: 'hidden',
  },
  pass: { backgroundColor: '#2e7d32' },
  fail: { backgroundColor: '#c62828' },
  rowText: { flex: 1 },
  name: { fontSize: 14, fontWeight: '500' },
  detail: { fontSize: 12, color: '#c62828', fontFamily: 'Courier' },
});
