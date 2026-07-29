// A small, real markdown parser — block scan then inline scan — plus the
// document the editor screen types into.
//
// This module is imported by BOTH `screens/MarkdownEditorScreen.tsx` and
// `workers/markdown.ts`. That is the whole point of the example: the work is
// identical, and the only thing that changes is which thread runs it.
//
// It is deliberately naive in the way every editor starts out: there is no
// incremental reparse, so one keystroke re-parses the entire document.

export type Span =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

export type Block =
  | { type: 'h'; level: number; spans: Span[] }
  | { type: 'p'; spans: Span[] }
  | { type: 'li'; ordered: boolean; spans: Span[] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' };

export type Doc = {
  blocks: Block[];
  outline: { level: number; text: string }[];
  words: number;
  chars: number;
  links: string[];
  codeBlocks: number;
  readingSec: number;
  /** Ranked completion candidates — what word-completion in an editor runs on. */
  topWords: { w: string; c: number }[];
  unique: number;
};

/** Inline pass: `**strong**`, `*em*`, `` `code` ``, `[text](href)`. */
function inline(src: string): Span[] {
  const spans: Span[] = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text) {
      spans.push({ t: 'text', v: text });
      text = '';
    }
  };

  while (i < src.length) {
    const c = src.charCodeAt(i);

    // ** strong **
    if (c === 42 /* * */ && src.charCodeAt(i + 1) === 42) {
      const end = src.indexOf('**', i + 2);
      if (end > 0) {
        flush();
        spans.push({ t: 'strong', v: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // * em *
    if (c === 42) {
      const end = src.indexOf('*', i + 1);
      if (end > 0 && end !== i + 1) {
        flush();
        spans.push({ t: 'em', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // `code`
    if (c === 96 /* ` */) {
      const end = src.indexOf('`', i + 1);
      if (end > 0) {
        flush();
        spans.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // [text](href)
    if (c === 91 /* [ */) {
      const close = src.indexOf(']', i + 1);
      if (close > 0 && src.charCodeAt(close + 1) === 40 /* ( */) {
        const paren = src.indexOf(')', close + 2);
        if (paren > 0) {
          flush();
          spans.push({
            t: 'link',
            v: src.slice(i + 1, close),
            href: src.slice(close + 2, paren),
          });
          i = paren + 1;
          continue;
        }
      }
    }

    text += src[i];
    i++;
  }

  flush();
  return spans;
}

const WORD_RE = /[A-Za-z0-9’'-]+/g;

/** Block pass. One full parse of the whole document, every time. */
export function parseMarkdown(src: string): Doc {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  const outline: { level: number; text: string }[] = [];
  const links: string[] = [];
  let words = 0;
  let codeBlocks = 0;

  // The word-completion index. Any editor with autocomplete rebuilds one of
  // these; naively, that means every word in the document on every keystroke.
  const index = new Map<string, number>();
  const count = (text: string) => {
    const found = text.match(WORD_RE);
    if (!found) return;
    words += found.length;
    for (let i = 0; i < found.length; i++) {
      const w = found[i]!.toLowerCase();
      index.set(w, (index.get(w) ?? 0) + 1);
    }
  };

  let para: string[] = [];

  const closeParagraph = () => {
    if (!para.length) return;
    const joined = para.join(' ');
    blocks.push({ type: 'p', spans: inline(joined) });
    count(joined);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();

    if (!trimmed) {
      closeParagraph();
      continue;
    }

    // fenced code
    if (trimmed.startsWith('```')) {
      closeParagraph();
      const lang = trimmed.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      codeBlocks++;
      continue;
    }

    // heading
    if (trimmed.charCodeAt(0) === 35 /* # */) {
      closeParagraph();
      let level = 0;
      while (trimmed.charCodeAt(level) === 35) level++;
      const text = trimmed.slice(level).trim();
      blocks.push({ type: 'h', level, spans: inline(text) });
      outline.push({ level, text });
      count(text);
      continue;
    }

    // rule
    if (trimmed === '---' || trimmed === '***') {
      closeParagraph();
      blocks.push({ type: 'hr' });
      continue;
    }

    // quote
    if (trimmed.charCodeAt(0) === 62 /* > */) {
      closeParagraph();
      const text = trimmed.slice(1).trim();
      blocks.push({ type: 'quote', spans: inline(text) });
      count(text);
      continue;
    }

    // list item
    const bullet = /^([-*+]|\d+\.)\s+/.exec(trimmed);
    if (bullet) {
      closeParagraph();
      const text = trimmed.slice(bullet[0].length);
      blocks.push({
        type: 'li',
        ordered: /\d/.test(bullet[1] ?? ''),
        spans: inline(text),
      });
      count(text);
      continue;
    }

    para.push(trimmed);
  }
  closeParagraph();

  // link inventory — every editor wants one, and it means walking every span
  for (const b of blocks) {
    if ('spans' in b) {
      for (const s of b.spans) if (s.t === 'link') links.push(s.href);
    }
  }

  // Rank the candidates. Completion wants the most-used words first, so the
  // whole index gets sorted — again, on every keystroke.
  const ranked = Array.from(index, ([w, c]) => ({ w, c })).sort(
    (a, b) => b.c - a.c
  );

  return {
    blocks,
    outline,
    words,
    chars: src.length,
    links,
    codeBlocks,
    readingSec: Math.ceil(words / (238 / 60)),
    topWords: ranked.slice(0, 8),
    unique: ranked.length,
  };
}

/* ------------------------------------------------------------------ corpus */

const CHAPTER = `## §{{n}} — Threading model

React Native runs your JavaScript on **one thread**. Every parse, every filter,
every hash competes with layout and gesture handling for the same runtime. The
symptom is always the same: a *frame budget* of 16.7ms, spent somewhere else.

> A worker is a normal module that happens to run on its own thread.

- \`postMessage\` in, \`onmessage\` out, [terminate](https://example.com/api/{{n}}) when done
- each worker is a real Hermes runtime with its own event loop and heap
- nothing is shared implicitly — messages cross via structured clone

\`\`\`ts
const worker = new Worker('./workers/markdown');
worker.postMessage({ seq: {{n}}, text });
\`\`\`

The interesting part is not that the work goes *somewhere else*. It is that the
main thread stops caring how long it takes. A parse that costs **{{n}} ms** costs
the UI nothing at all, and the editor keeps painting at sixty frames a second
while it runs. See [the notes](https://example.com/notes/{{n}}) for the numbers.

`;

/** Builds a document of roughly `kb` kilobytes out of repeated chapters. */
export function buildDocument(kb: number): string {
  const head = `# The Threading Handbook

A working document, edited live. Every keystroke below re-parses **all of it**.

`;
  let out = head;
  let n = 1;
  const target = kb * 1024;
  while (out.length < target) {
    out += CHAPTER.replace(/\{\{n\}\}/g, String(n));
    n++;
  }
  return out;
}

/** The sentence the showcase loop types, one character at a time. */
export const TYPED_SENTENCE =
  'Parsing this document on every keystroke is the whole problem, and moving it off the JS thread is the whole fix. ';
