// A third-party TurboModule (react-native-blob-util) used through its normal JS
// wrapper inside a worker — writing and reading a file off the UI thread.
import ReactNativeBlobUtil from 'react-native-blob-util';

declare const self: any;

const TEXT = 'hello from a worker thread';

self.onmessage = async (_e: MessageEvent) => {
  const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/rnworkers-blobutil.txt`;
  try {
    await ReactNativeBlobUtil.fs.writeFile(path, TEXT, 'utf8');
    const readBack = await ReactNativeBlobUtil.fs.readFile(path, 'utf8');
    const exists = await ReactNativeBlobUtil.fs.exists(path);
    await ReactNativeBlobUtil.fs.unlink(path);
    self.postMessage({ ok: exists && readBack === TEXT, readBack });
  } catch (err: any) {
    self.postMessage({ __error: String(err?.message ?? err) });
  }
};
