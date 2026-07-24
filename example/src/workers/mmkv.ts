// A pure-JSI library (react-native-mmkv-storage) used inside a worker.
// Its native module installs C++ bindings directly onto a jsi::Runtime, which is
// a different integration path from a TurboModule call — this worker checks
// whether those bindings land on the worker's own runtime.
import { MMKVLoader } from 'react-native-mmkv-storage';

declare const self: any;

self.onmessage = async (_e: MessageEvent) => {
  try {
    const storage = new MMKVLoader().withInstanceID('rnworkers').initialize();
    storage.setString('from-worker', 'hello');
    const readBack = storage.getString('from-worker');
    self.postMessage({
      ok: readBack === 'hello',
      readBack,
      // Did the JSI bindings actually land on THIS runtime's global?
      installedHere: typeof (globalThis as any).getStringMMKV === 'function',
    });
  } catch (err: any) {
    self.postMessage({
      __error: String(err?.message ?? err),
      installedHere: typeof (globalThis as any).getStringMMKV === 'function',
    });
  }
};
