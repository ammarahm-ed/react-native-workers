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
  // e.g. http://localhost:8081/index.bundle?platform=ios&dev=true
  const base = scriptURL
    ? scriptURL.replace(/\/[^/]*$/, '/')
    : 'http://localhost:8081/';
  // `resolver.rnworkers` marks this as a worker graph, which is what makes the
  // `withWorkers()` Metro config resolve `react-native` to the worker shim
  // instead of the full barrel. It must match the flag the release CLI passes,
  // or a worker would bundle differently in dev than it ships.
  const query =
    `platform=${Platform.OS}&dev=true&minify=false&modulesOnly=false&runModule=true` +
    `&resolver.rnworkers=true`;
  return `${base}${id}.bundle?${query}`;
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
