// A legacy (old-architecture) native module used inside a worker.
// react-native-gzip exposes NativeModules.Gzip, which workers resolve through
// the same bridgeless `nativeModuleProxy` the host uses.
import { deflate, inflate } from 'react-native-gzip';

declare const self: any;

self.onmessage = async (e: MessageEvent) => {
  const text = e.data as string;
  try {
    const base64 = await deflate(text);
    const restored = await inflate(base64);
    self.postMessage({ ok: restored === text, base64Length: base64.length });
  } catch (err: any) {
    self.postMessage({ __error: String(err?.message ?? err) });
  }
};
