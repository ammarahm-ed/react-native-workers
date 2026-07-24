// A bundled worker entry, compiled by Metro and loaded via new Worker('./workers/double').
// Runs in an isolated Hermes runtime with WorkerGlobalScope semantics.

declare const self: any;

self.onmessage = (e: MessageEvent) => {
  const n = e.data as number;
  self.postMessage({ doubled: n * 2, from: 'bundled-worker' });
};

self.postMessage({ ready: true });
