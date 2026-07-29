// The markdown editor's parse thread.
//
// It imports the SAME parser module the screen imports — `helpers/markdown` —
// so the work being done here is byte-for-byte the work the JS thread would
// have done. Only the thread changes.
//
// Two things make this usable rather than just "off-thread":
//
//   1. The worker owns the document. The host sends the *edit*, not the text.
//      Shipping a 400KB string on every keystroke costs more in encode/decode
//      than the parse itself, and the queue grows without bound — the UI stays
//      smooth but the preview falls seconds behind. A one-character message
//      does not.
//   2. Edits are applied every time; parses are coalesced. Keystrokes arrive
//      faster than a full parse finishes, so the queue drains into the document
//      first and only the resulting text is parsed — once.
//
//   3. A small reply. The parsed document is large; the editor only renders the
//      lines on screen, so the worker sends back the visible slice and stats,
//      never the whole AST.
export {};

import { parseMarkdown, type Block } from './helpers/markdown';

declare const self: any;

/** How many blocks the editor shows at once. */
const WINDOW = 16;
/**
 * Floor on the gap between parses. A parse costs more than the gap between two
 * keystrokes, so parsing on every edit means the worker can never catch up and
 * the preview drifts seconds behind. Batching to ~10 parses a second keeps it
 * within a frame or two of the caret — the throttle every editor ends up with.
 */
const PARSE_EVERY_MS = 100;

/** The worker's own copy of the document. */
let text = '';
let seq = 0;
let sentAt = 0;
let scheduled = false;
let dirty = false;

self.onmessage = (e: MessageEvent) => {
  const d = e.data as any;

  // Every edit is applied — none are ever dropped.
  if (d.reset) text = d.text;
  else text += d.append;

  seq = d.seq;
  sentAt = d.sentAt;
  dirty = true;

  if (scheduled) return;
  scheduled = true;
  // Yield first: everything already queued behind this message lands in `text`
  // before we commit, so a burst of keystrokes costs exactly one parse.
  const since = Date.now() - lastRunAt;
  setTimeout(run, Math.max(0, PARSE_EVERY_MS - since));
};

let lastRunAt = 0;

function run() {
  scheduled = false;
  if (!dirty) return;
  dirty = false;
  lastRunAt = Date.now();

  const t0 = performance.now();
  const doc = parseMarkdown(text);
  const parseMs = performance.now() - t0;

  const start = Math.max(0, doc.blocks.length - WINDOW);
  const view: Block[] = doc.blocks.slice(start, start + WINDOW);

  self.postMessage({
    seq,
    parseMs,
    view,
    blocks: doc.blocks.length,
    words: doc.words,
    unique: doc.unique,
    chars: doc.chars,
    headings: doc.outline.length,
    links: doc.links.length,
    codeBlocks: doc.codeBlocks,
    readingSec: doc.readingSec,
    // Echoed, not restamped: the host measures keystroke → drawn, which is the
    // number that matters. Restamping here would only measure the reply leg.
    sentAt,
  });
}

self.postMessage({ ready: true });
