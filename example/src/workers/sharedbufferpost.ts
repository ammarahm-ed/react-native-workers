/**
 * Receives a SharedBuffer through postMessage and proves it is the SAME memory,
 * not a copy: it reads what the host wrote before sending, then writes back a
 * marker the host checks in its own view.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;

self.onmessage = (e: any) => {
  const buf = e.data?.buffer;
  try {
    const view = new Uint8Array(buf.arrayBuffer);
    const sawHostByte = view[0];
    view[1] = 99; // the host checks this in the buffer it still holds
    self.postMessage({
      ok: true,
      sawHostByte,
      byteLength: buf.byteLength,
      name: buf.name,
      isSharedBuffer: typeof buf.withLock === 'function',
    });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String((err as any)?.message ?? err),
    });
  }
};
