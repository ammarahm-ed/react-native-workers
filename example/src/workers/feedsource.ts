// The live half of the feed: a firehose of engagement events, the way a real
// app gets them off a socket.
//
// This worker is the single writer of `LIVE_BUFFER` — two Int32s per row,
// likes and replies. It writes ~2,000 updates a second straight into shared
// memory, which is all the UIWorker's list needs: that list reads the rows it
// is currently showing, from the same bytes, on the main thread.
//
// It sends nothing to anyone. The only thing it publishes is a rate, in a
// shared cell, so the screen has a number to show.
import {
  FEED_COUNT,
  LIVE_BUFFER,
  LIVE_BYTES,
  LIVE_STRIDE,
} from './helpers/feed';

export {};

declare const SharedBuffer: any;
declare const SharedValue: any;
declare const self: any;

/** Events produced per second. A busy feed, not a stress test. */
const EVENTS_PER_SEC = 2000;
/** How often the producer wakes up (ms) — one frame's worth of events. */
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
let since = Date.now();
const rate = new SharedValue('feed.events', 0);

function burst(n: number) {
  for (let k = 0; k < n; k++) {
    // Weighted towards the top of the feed, like a real timeline.
    const row = Math.floor(Math.pow(Math.random(), 2) * FEED_COUNT);
    const base = row * LIVE_STRIDE;
    live[base] = live[base]! + 1 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.25) live[base + 1] = live[base + 1]! + 1;
    produced++;
  }
}

function tick() {
  burst(Math.round((EVENTS_PER_SEC * POST_MS) / 1000));
  const now = Date.now();
  if (now - since >= 500) {
    rate.value = Math.round(produced / ((now - since) / 1000));
    produced = 0;
    since = now;
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
