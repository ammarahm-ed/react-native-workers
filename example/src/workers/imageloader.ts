/**
 * Proves RN's image loader actually decodes inside a worker.
 *
 * On iOS `RCTImageLoader` is one of the two modules the HOST normally constructs
 * with injected dependency providers (the other is `RCTNetworking`). Built plainly
 * in a worker it had no loaders and no decoders, and — one level deeper — it looks
 * its peer `Networking` module up through `moduleRegistry`, which a worker used to
 * answer with nil. Both failed silently as "no suitable image URL loader".
 *
 * The image is a 1x1 GIF written to disk first, then loaded over `file://`:
 *
 * - it round-trips through the URL-handler list (file requests) on iOS,
 * - and it decodes, so an empty decoder list cannot pass,
 * - and unlike a `data:` URI it works on Android too, where Fresco rejects
 *   `data:` for `getSize` ("Unsupported uri scheme for encoded image fetch").
 *
 * Asserting 1x1 rather than "it resolved" is the point: a resolved-but-undecoded
 * image reports nothing useful.
 */
export {}; // module scope, so `self` below doesn't collide with other workers

declare const self: any;
// Installed by the worker's TurboModule binding, so it is not on the app's
// `globalThis` type.
declare const __rnworkersGetModule: (name: string) => any;

import ReactNativeBlobUtil from 'react-native-blob-util';

// 1x1 transparent GIF.
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

self.onmessage = async () => {
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/rnworkers-pixel.gif`;
  try {
    await ReactNativeBlobUtil.fs.writeFile(path, GIF_BASE64, 'base64');

    const loader = __rnworkersGetModule('ImageLoader');
    if (!loader || typeof loader.getSize !== 'function') {
      self.postMessage({ resolved: !!loader, hasGetSize: false });
      return;
    }

    const size = await loader.getSize(`file://${path}`);
    // iOS resolves [width, height]; Android resolves the same tuple shape.
    self.postMessage({
      resolved: true,
      hasGetSize: true,
      width: Array.isArray(size) ? size[0] : size?.width,
      height: Array.isArray(size) ? size[1] : size?.height,
    });
  } catch (err) {
    self.postMessage({
      resolved: true,
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
