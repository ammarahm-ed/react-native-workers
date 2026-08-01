// The feed's data model, shared by every runtime in the example.
//
// The static half of a row (author, handle, body, which thumbnail) is
// deterministic: `buildFeed(n)` returns the same 5,000 rows in every runtime
// that calls it, so nothing static ever has to cross a thread boundary.
//
// The live half — likes and replies, arriving thousands of times a second —
// lives in ONE shared buffer (`LIVE_BUFFER`), two Int32s per row. The producer
// worker writes into it; the UIWorker reads the rows that are on screen. No
// copy, no message, no notification.

export type FeedItem = {
  id: number;
  author: string;
  handle: string;
  body: string;
  /** The row's second line — feeds are rarely one line. */
  detail: string;
  topic: string;
  /** Index into the generated thumbnail set. */
  art: number;
  /** A second image — the link preview every feed row seems to have. */
  preview: number;
  /** Minutes ago. */
  age: number;
  /** Body lines this post needs — the row's height follows from it. */
  lines: number;
};

/** Rows in the feed. */
export const FEED_COUNT = 20000;
/** Name of the shared block holding [likes, replies] per row. */
export const LIVE_BUFFER = 'feed.live';
/** Int32s per row in that block. */
export const LIVE_STRIDE = 2;
export const LIVE_BYTES = FEED_COUNT * LIVE_STRIDE * 4;

/**
 * Rows are NOT all the same height — the body is one to four lines depending
 * on how long the post is, which is what a feed actually looks like and why a
 * list cannot be handed its layout up front.
 */
export const MAX_LINES = 4;
/** Characters that fit on one line of body text at this column width. */
const CHARS_PER_LINE = 28;
/** Everything in a row that is not body text: header, detail, preview, footer. */
const ROW_CHROME = 142;

/** How many lines this post's body needs. */
export function linesFor(body: string): number {
  return Math.min(
    MAX_LINES,
    Math.max(1, Math.ceil(body.length / CHARS_PER_LINE))
  );
}

/** A row's height, from its content. */
export function rowHeight(lines: number): number {
  return ROW_CHROME + lines * 14;
}
/** Thumbnails generated once by the UIWorker. */
export const ART_COUNT = 24;

const FIRST = [
  'Ada',
  'Rune',
  'Mira',
  'Tomek',
  'Iris',
  'Kai',
  'Noor',
  'Sasha',
  'Lena',
  'Owen',
  'Yuki',
  'Farah',
  'Diego',
  'Priya',
  'Jonas',
  'Zoe',
];
const LAST = [
  'Okafor',
  'Halvorsen',
  'Ito',
  'Nowak',
  'Marsh',
  'Delgado',
  'Ferreira',
  'Kowal',
  'Brennan',
  'Sato',
];
const TOPICS = [
  '#perf',
  '#ios',
  '#android',
  '#release',
  '#bug',
  '#infra',
  '#design',
];
const DETAIL = [
  'profiled it on a 3-year-old device before and after',
  'the diff is 40 lines, most of it deletions',
  'repro is in the issue, happens on every cold start',
  'still not sure why it only shows up in release builds',
  'benchmarked over 20 runs, the spread is tiny',
  'we shipped it behind a flag on Tuesday',
  'the trace shows one long block, nothing else',
];
const BODY = [
  'shipped it 🚀',
  'no more jank',
  'fixed, finally',
  'rewrote the list — recycling instead of remounting, and the frame budget went from 22ms down to under 4ms on the same device',
  'the profiler is unambiguous: we spend 300ms in JSON.parse on every cold start, and it is all on the thread that draws',
  'shipped the new sync engine, 40% fewer round trips',
  'the profiler says we spend 300ms in JSON.parse on boot',
  'rewrote the list — recycling instead of remounting',
  'anyone else seeing dropped frames after the upgrade?',
  'benchmark: 5k rows, 120fps, no main-thread work',
  'turns out the jank was one setState in a scroll handler',
  'moved the parser off the JS thread and never looked back',
  'live prices at 2k/s used to melt this screen',
  'the cell recycles, so only the labels change',
  'shared memory instead of postMessage was the whole fix',
  'deleted 400 lines of native code today',
  'the feed keeps ticking while the JS thread is pinned',
];

/** Tiny deterministic PRNG, so every runtime builds the identical feed. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFeed(count: number = FEED_COUNT): FeedItem[] {
  const rand = mulberry(0xfeed);
  const items: FeedItem[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)]!;
    const last = LAST[Math.floor(rand() * LAST.length)]!;
    items[i] = {
      id: i,
      author: `${first} ${last}`,
      handle: `@${first.toLowerCase()}${Math.floor(rand() * 900 + 10)}`,
      body: BODY[Math.floor(rand() * BODY.length)]!,
      detail: DETAIL[Math.floor(rand() * DETAIL.length)]!,
      topic: TOPICS[Math.floor(rand() * TOPICS.length)]!,
      lines: 0, // filled in below, from the body text
      art: Math.floor(rand() * ART_COUNT),
      preview: Math.floor(rand() * ART_COUNT),
      age: 1 + Math.floor(rand() * 240),
    };
    items[i]!.lines = linesFor(items[i]!.body);
  }
  return items;
}

/** 1240 → "1.2k" — what a feed row actually shows. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(1)}m`;
}
