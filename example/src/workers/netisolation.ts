/**
 * Proves a worker's network I/O does not depend on the host JS thread.
 *
 * `XMLHttpRequest` goes through RN's networking module, which reports progress and
 * completion as *device events*. Those are the events that used to be raised on the
 * host runtime and forwarded (see WorkerDeviceEventEmitter): if that were still the
 * case, this request could not finish while the host JS thread is blocked.
 *
 * The worker reports when the response landed **on its own clock**, because the host
 * cannot observe anything while it is pinned — the reply is only read once the host
 * is free again, and the timestamps are what prove the ordering.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;

// The worker shim re-exports `XMLHttpRequest` from the 'react-native' barrel;
// RN's public types don't declare it, since in the app runtime it's a global.
const { XMLHttpRequest: WorkerXHR } = require('react-native') as {
  XMLHttpRequest: any;
};

self.onmessage = (e: any) => {
  // The host waits for this before it starts blocking, so the measurement covers
  // the request only — not this worker's startup (bundle fetch + evaluation).
  if (e?.data?.ping) {
    self.postMessage({ phase: 'ready' });
    return;
  }

  const url = e?.data?.url;
  if (!url) {
    self.postMessage({ ok: false, error: 'no url' });
    return;
  }
  const startedAt = Date.now();
  try {
    const xhr = new WorkerXHR();
    xhr.open('GET', url);
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      self.postMessage({
        ok: xhr.status > 0,
        status: xhr.status,
        startedAt,
        completedAt: Date.now(),
      });
    };
    xhr.onerror = () => {
      self.postMessage({
        ok: false,
        error: 'xhr error',
        startedAt,
        completedAt: Date.now(),
      });
    };
    xhr.send();
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String((err as any)?.message ?? err),
      startedAt,
      completedAt: Date.now(),
    });
  }
};
