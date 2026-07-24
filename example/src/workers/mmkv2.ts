// react-native-mmkv v4 (Nitro-based) inside a worker. Nitro installs its
// `NitroModulesProxy` entry-point against a jsi::Runtime taken from the React
// context, so this checks whether that proxy lands on the worker's own runtime.
import { createMMKV } from 'react-native-mmkv';

declare const self: any;

self.onmessage = async (_e: MessageEvent) => {
  const installedHere =
    typeof (globalThis as any).NitroModulesProxy !== 'undefined';
  try {
    const storage = createMMKV({ id: 'rnworkers-mmkv' });
    storage.set('from-worker', 'hello');
    const readBack = storage.getString('from-worker');
    self.postMessage({ ok: readBack === 'hello', readBack, installedHere });
  } catch (err: any) {
    self.postMessage({ __error: String(err?.message ?? err), installedHere });
  }
};
