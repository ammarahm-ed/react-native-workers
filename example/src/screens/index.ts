import type { ComponentType } from 'react';
import TestsScreen from './TestsScreen';
import BenchmarksScreen from './BenchmarksScreen';
import UIWorkerDemoScreen from './UIWorkerDemoScreen';
import NativeScriptScreen from './NativeScriptScreen';
import NativeComponentScreen from './NativeComponentScreen';
import SearchServiceScreen from './SearchServiceScreen';
import NotesScreen from './NotesScreen';
import DownloadsScreen from './DownloadsScreen';
import ImageFxScreen from './ImageFxScreen';
import SensorScreen from './SensorScreen';
import ParseScreen from './ParseScreen';
import FeedScreen from './FeedScreen';

export type ScreenId = string;

export type ScreenDef = {
  /** Stable id — also what `RN_WORKERS_SCREEN` matches against. */
  id: ScreenId;
  title: string;
  /** One line shown under the title on the home list. */
  blurb: string;
  component: ComponentType;
};

/**
 * Every screen the example app can show. Adding an example is one entry here —
 * the home list, the router and the `RN_WORKERS_SCREEN` deep-link all read from
 * this array, so there is nothing else to register.
 */
export const SCREENS: ScreenDef[] = [
  {
    id: 'notes',
    title: 'Note editor (SharedStore)',
    blurb: 'Live stats + autosave computed in a worker, zero messages',
    component: NotesScreen,
  },
  {
    id: 'feed',
    title: 'Live feed (UICollectionView in a UIWorker)',
    blurb: '5,000 rows recycled and repainted off the JS thread — iOS only',
    component: FeedScreen,
  },
  {
    id: 'parse',
    title: 'Parallel parse (nested workers)',
    blurb:
      'A coordinator fans 3MB of logs out to child workers, and measures it',
    component: ParseScreen,
  },
  {
    id: 'sensor',
    title: 'Sensor stream (ring buffer + withLock)',
    blurb: 'A producer at 1000Hz, a UI reading it 30 times a second',
    component: SensorScreen,
  },
  {
    id: 'imagefx',
    title: 'Image filters (SharedBuffer)',
    blurb: 'Raw pixels in shared memory, filtered off the JS thread',
    component: ImageFxScreen,
  },
  {
    id: 'downloads',
    title: 'Transfer manager (SharedValue)',
    blurb: 'High-frequency progress in shared cells, sampled once per frame',
    component: DownloadsScreen,
  },
  {
    id: 'search',
    title: 'Search service (JSModule RPC)',
    blurb: 'Worker owns the index; typed two-way calls and streamed events',
    component: SearchServiceScreen,
  },
  {
    id: 'uiworker',
    title: 'UIWorker: direct UI calls',
    blurb: 'Native UI from a worker on the main thread, with no dispatch',
    component: UIWorkerDemoScreen,
  },
  {
    id: 'nativescript',
    title: 'NativeScript interop (UIWorker)',
    blurb: 'The whole iOS SDK called straight from a worker — iOS only',
    component: NativeScriptScreen,
  },
  {
    id: 'nativecomponent',
    title: 'Native component defined in JS (UIWorker)',
    blurb:
      'A view manager registered from the worker, used via requireNativeComponent',
    component: NativeComponentScreen,
  },
  {
    id: 'tests',
    title: 'Test suite',
    blurb: 'Full conformance, bridge and shared-primitive tests',
    component: TestsScreen,
  },
  {
    id: 'benchmarks',
    title: 'Benchmarks',
    blurb: 'Throughput and latency of workers vs the JS thread',
    component: BenchmarksScreen,
  },
];

export function findScreen(id: string | undefined): ScreenDef | undefined {
  if (!id) return undefined;
  return SCREENS.find((s) => s.id === id);
}
