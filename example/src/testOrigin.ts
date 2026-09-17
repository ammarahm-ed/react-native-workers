import { NativeModules } from 'react-native';

/**
 * The HTTP origin the two isolation tests make their requests against.
 *
 * They are about RN's networking *device events* — `didReceiveNetworkResponse`
 * and friends — so they need a real request to a real endpoint; there is no way
 * to fake that without also faking the thing under test. In a dev build the
 * endpoint is Metro, reached through the origin of `SourceCode.scriptURL`.
 *
 * A release bundle has no dev server, and `scriptURL` there is `assets://` (or a
 * file path on iOS), so it has no origin to take. Rather than skip — which is
 * indistinguishable from passing, the exact green-but-meaningless suite these
 * tests exist to prevent — the app starts its own loopback HTTP server
 * (`TestHttpServer`, one per platform) and the exchange stays a genuine one.
 * Nothing the tests measure depends on *who* answers.
 *
 * Resolved once per app run: the server is cheap but starting one per test would
 * leave a listener behind for each.
 */
let pending: Promise<string | null> | null = null;

export function resolveTestOrigin(): Promise<string | null> {
  if (!pending) {
    pending = resolve();
  }
  return pending;
}

async function resolve(): Promise<string | null> {
  const scriptURL = (NativeModules as any)?.SourceCode?.getConstants?.()
    .scriptURL;
  const devServer = scriptURL
    ? String(scriptURL).match(/^https?:\/\/[^/]+/)?.[0]
    : null;
  if (devServer) {
    return devServer;
  }
  try {
    return (
      ((await (NativeModules as any)?.TestHttpServer?.start?.()) as string) ??
      null
    );
  } catch {
    return null;
  }
}
