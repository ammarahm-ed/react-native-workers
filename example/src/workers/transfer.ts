/**
 * Transfer probe: receives a buffer, mutates it, and transfers it BACK.
 *
 * The return hop is the interesting one — whatever the sender started with, the
 * buffer this worker holds was created by us over a MutableBuffer, so it is
 * `external()` and transfers with no copy.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;

self.onmessage = (e: any) => {
  try {
    const ab = e.data?.buffer;
    const view = new Uint8Array(ab);
    const sawHostByte = view[0];
    view[1] = 88; // host checks its own (pre-transfer) view for this
    view[2] = 55; // and checks this in the buffer it gets BACK

    // Send it home, transferring again.
    self.postMessage({ buffer: ab, sawHostByte, byteLength: ab.byteLength }, [
      ab,
    ]);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String((err as any)?.message ?? err),
    });
  }
};
