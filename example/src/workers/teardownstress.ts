/**
 * A worker that is ALWAYS mid-native-call, so terminating it lands on a busy queue.
 *
 * The existing teardown test terminates each worker only after its reply arrives —
 * i.e. when nothing is in flight — so it never exercises the case the per-worker
 * native queue actually has to survive: teardown while module bodies are still
 * running on the queue thread, with their completions about to hop back onto a JS
 * runtime that is being destroyed.
 *
 * This worker keeps several native reads permanently in flight: each one
 * re-arms as soon as it settles, and nothing ever stops the loop. Whenever the
 * host calls terminate(), there is queue work running and continuations pending.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;

import ReactNativeBlobUtil from 'react-native-blob-util';

self.onmessage = async () => {
  // Per-worker path: many of these run at once and must not fight over one file.
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/rnworkers-stress-${Math.random()
    .toString(36)
    .slice(2)}.bin`;
  try {
    await ReactNativeBlobUtil.fs.writeFile(path, 'x'.repeat(32 * 1024), 'utf8');
  } catch (err) {
    self.postMessage({
      ready: false,
      error: String((err as any)?.message ?? err),
    });
    return;
  }

  // Deliberately unbounded and never awaited. Both handlers re-arm, so a read
  // failing (the file is unlinked, the module is invalidated) keeps the pressure
  // on rather than quietly draining the queue.
  const pump = () => {
    try {
      ReactNativeBlobUtil.fs.readFile(path, 'base64').then(pump, pump);
    } catch {
      // The module is gone (teardown). Nothing to re-arm.
    }
  };
  for (let i = 0; i < 4; i++) {
    pump();
  }

  // Only now is the queue guaranteed busy, so the host can safely terminate.
  self.postMessage({ ready: true });
};
