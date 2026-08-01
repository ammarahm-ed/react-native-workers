// The live half of the feed: a firehose of engagement events, the way a real
// app gets them off a socket.
//
// This worker is the single writer of `LIVE_BUFFER` — two Int32s per row,
// likes and replies. It writes ~2,000 updates a second straight into shared
// memory, which is all the UIWorker's list needs: that list reads the rows it
// is currently showing, from the same bytes, on the main thread.
//
// It ALSO posts the same events to the host as messages, coalesced per frame,
// because that is the only way the React list can see them. That second path is
// the one this example is measuring.
import {
  FEED_COUNT,
  LIVE_BUFFER,
  LIVE_BYTES,
  LIVE_STRIDE,
} from './helpers/feed';

export {};

declare const SharedBuffer: any;
declare const self: any;

/** Events produced per second. A busy feed, not a stress test. */
const EVENTS_PER_SEC = 2000;
/** How often the batch for the host goes out (ms) — one frame. */
const POST_MS = 16;

const live = new Int32Array(
  new SharedBuffer(LIVE_BUFFER, LIVE_BYTES).arrayBuffer
);

// Seed every row with a plausible starting count.
for (let i = 0; i < FEED_COUNT; i++) {
  live[i * LIVE_STRIDE] = 12 + ((i * 37) % 900);
  live[i * LIVE_STRIDE + 1] = 1 + ((i * 11) % 60);
}

let running = false;
let timer: any = null;
let produced = 0;
/** Rows touched since the last post, coalesced — a socket client's queue. */
let pending = new Set<number>();

function burst(n: number) {
  for (let k = 0; k < n; k++) {
    // Weighted towards the top of the feed, like a real timeline.
    const row = Math.floor(Math.pow(Math.random(), 2) * FEED_COUNT);
    const base = row * LIVE_STRIDE;
    live[base] = live[base]! + 1 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.25) live[base + 1] = live[base + 1]! + 1;
    pending.add(row);
    produced++;
  }
}

function tick() {
  burst(Math.round((EVENTS_PER_SEC * POST_MS) / 1000));
  if (pending.size) {
    // The host cannot read shared memory the way the UIWorker can — it needs
    // the values as data. Flatten to [row, likes, replies, …] and copy them
    // across, which is what a socket client would hand React anyway.
    const flat = new Array(pending.size * 3);
    let i = 0;
    for (const row of pending) {
      flat[i++] = row;
      flat[i++] = live[row * LIVE_STRIDE]!;
      flat[i++] = live[row * LIVE_STRIDE + 1]!;
    }
    pending = new Set();
    // A socket frame is text, and a socket client parses it. Sending the batch
    // the way it actually arrives keeps the JS thread's side of this honest.
    self.postMessage({ frame: JSON.stringify(flat), produced });
  }
}

self.onmessage = (e: any) => {
  const d = e.data ?? {};
  if (d.start && !running) {
    running = true;
    timer = setInterval(tick, POST_MS);
  }
  if (d.stop && running) {
    running = false;
    clearInterval(timer);
    timer = null;
  }
};

self.postMessage({ ready: true, rows: FEED_COUNT });
