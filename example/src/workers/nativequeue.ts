/**
 * Proves a native module's method body does not run on the worker's JS thread.
 *
 * The worker times the *synchronous* part of a native call — the window in which
 * its own event loop is unavailable. Dispatched onto the worker's native queue that
 * window is just the dispatch; run inline on the JS thread (as it used to be) it is
 * the entire operation.
 *
 * The call deliberately takes tiny arguments and does heavy work: reading a large
 * file by path. Argument marshalling happens on the JS thread either way, so a call
 * with a large *argument* (compressing a big string, say) would look synchronous
 * even when the body is queued, and would prove nothing.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;

import ReactNativeBlobUtil from 'react-native-blob-util';

self.onmessage = async () => {
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/rnworkers-queue-probe.bin`;
  try {
    // Setup (untimed): a file big enough that reading it clearly outlasts a hop.
    let chunk = '';
    for (let i = 0; i < 1024; i++) {
      chunk += String.fromCharCode(65 + (i % 26));
    }
    await ReactNativeBlobUtil.fs.writeFile(
      path,
      chunk.repeat(8 * 1024),
      'utf8'
    );

    const t0 = Date.now();
    const pending = ReactNativeBlobUtil.fs.readFile(path, 'base64');
    // Everything up to here ran on the JS thread. Inline, the whole read is
    // already done; queued, only the dispatch is.
    const syncMs = Date.now() - t0;

    const contents = await pending;
    const totalMs = Date.now() - t0;

    self.postMessage({ ok: contents.length > 0, syncMs, totalMs });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String((err as any)?.message ?? err),
    });
  } finally {
    try {
      await ReactNativeBlobUtil.fs.unlink(path);
    } catch {
      // best effort
    }
  }
};
