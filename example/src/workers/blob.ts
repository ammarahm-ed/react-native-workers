// Exercises RN's Blob machinery inside a worker. Blob is backed by the native
// BlobModule; workers get a worker-safe shim for it (WorkerBlobModule.kt) plus
// their own `__blobCollectorProvider`, so creating and dropping many Blobs must
// neither fail nor crash on GC.
// `Blob` is not a worker global — RN installs it on the host via InitializeCore,
// which workers deliberately do not run — so pull it in directly.
import Blob from 'react-native/Libraries/Blob/Blob';

declare const self: any;

self.onmessage = async (_e: MessageEvent) => {
  try {
    const b = new Blob(['hello ', 'from a worker'], { type: 'text/plain' });

    // Churn a batch so the collector actually gets exercised by the GC.
    for (let i = 0; i < 200; i++) {
      // eslint-disable-next-line no-new
      new Blob(['payload-' + i]);
    }

    const sliced = b.slice(0, 5);
    self.postMessage({
      ok: b.size === 19 && b.type === 'text/plain' && sliced.size === 5,
      size: b.size,
      type: b.type,
      slicedSize: sliced.size,
    });
  } catch (err: any) {
    self.postMessage({ __error: String(err?.message ?? err) });
  }
};
