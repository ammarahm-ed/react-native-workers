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

    // Send it home, transferring again.
    self.postMessage({ buffer: ab, sawHostByte, byteLength: ab.byteLength }, [
      ab,
    ]);

    // Written AFTER the post, deliberately. A byte set BEFORE sending would
    // survive a plain copy too, so asserting on it proved nothing about the
    // return hop; this one can only reach the host if the buffer that came back
    // is the same allocation.
    view[3] = 77;
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String((err as any)?.message ?? err),
    });
  }
};
