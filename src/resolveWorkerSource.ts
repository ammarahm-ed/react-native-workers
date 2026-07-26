import { NativeModules, Platform } from 'react-native';

declare const __DEV__: boolean;

/** Opaque reference produced by the babel plugin's `__workerRef(id)`. */
export interface WorkerRef {
  readonly __rnworker: true;
  readonly id: string;
}

/** Inline worker source — always supported, mainly for tests/experiments. */
export interface InlineWorkerSource {
  readonly inline: string;
  readonly sourceUrl?: string;
}

export type WorkerSourceInput = WorkerRef | InlineWorkerSource | string;

export interface ResolvedSource {
  /** 'inline' | 'url' | 'asset' */
  kind: string;
  value: string;
  sourceUrl: string;
}

/** Canonical asset filename for a worker entry id (must match the release CLI). */
export function workerAssetName(id: string): string {
  return 'workers/' + id.replace(/[^a-zA-Z0-9]+/g, '_') + '.jsbundle';
}

function metroBundleUrl(id: string): string {
  const scriptURL: string | undefined =
    (NativeModules as any)?.SourceCode?.getConstants?.().scriptURL ??
    (NativeModules as any)?.SourceCode?.scriptURL;
  // A worker bundle is a Metro entry resolved from the project root and served at
  // `<origin>/<id>.bundle`, so the base must be just the server ORIGIN
  // (scheme://host:port) — NOT the directory the app's own bundle sits in. The
  // main bundle is not always at the server root: Expo serves it from a virtual
  // entry (e.g. `/.expo/.virtual-metro-entry.bundle`), so stripping the last path
  // segment would prepend `/.expo/` and 404. Taking the origin is correct on both
  // bare React Native and Expo, and on localhost or a LAN/device address.
  // e.g. http://localhost:8081/index.bundle?... or
  //      http://192.168.1.5:8081/.expo/.virtual-metro-entry.bundle?...
  const originMatch = scriptURL && scriptURL.match(/^(https?:\/\/[^/]+)/);
  const origin = originMatch ? originMatch[1] : 'http://localhost:8081';
  // `resolver.rnworkers` marks this as a worker graph, which is what makes the
  // `withWorkers()` Metro config resolve `react-native` to the worker shim
  // instead of the full barrel. It must match the flag the release CLI passes,
  // or a worker would bundle differently in dev than it ships.
  const query =
    `platform=${Platform.OS}&dev=true&minify=false&modulesOnly=false&runModule=true` +
    `&resolver.rnworkers=true`;
  return `${origin}/${id}.bundle?${query}`;
}

export function resolveWorkerSource(source: WorkerSourceInput): ResolvedSource {
  if (typeof source === 'object' && source && 'inline' in source) {
    return {
      kind: 'inline',
      value: source.inline,
      sourceUrl: source.sourceUrl ?? 'worker://inline',
    };
  }

  const id = typeof source === 'string' ? source : (source as WorkerRef).id;

  if (__DEV__) {
    const url = metroBundleUrl(id);
    return { kind: 'url', value: url, sourceUrl: url };
  }
  const asset = workerAssetName(id);
  return { kind: 'asset', value: asset, sourceUrl: asset };
}

/** Runtime helper the babel plugin rewrites `new Worker('./x')` to reference. */
export function __workerRef(id: string): WorkerRef {
  return { __rnworker: true, id };
}
