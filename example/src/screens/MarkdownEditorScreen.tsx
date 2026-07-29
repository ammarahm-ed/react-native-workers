import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Worker } from '@ammarahmed/react-native-workers';
import { markReady } from '../devReady';
import {
  buildDocument,
  parseMarkdown,
  TYPED_SENTENCE,
  type Block,
  type Span,
} from '../workers/helpers/markdown';

/**
 * A markdown editor that re-parses the whole document on every keystroke —
 * the way every editor starts out — with a switch for where the parse runs.
 *
 * The parser is one module, imported by this screen and by `workers/markdown`.
 * Nothing about the work changes between the two modes; only the thread does.
 */

/** Auto-run the typing loop and flip modes on a timer, for recording. */
const SHOWCASE = true;
/** Roughly how big the document is — a long handbook or a book manuscript. */
const DOC_KB = 400;
/** How long each mode holds before the showcase loop flips it. */
const MODE_MS = 7000;
/** Keystroke interval. Fast typing, not absurd. */
const TYPE_MS = 60;
/** Blocks kept on screen — the editor only renders what's visible. */
const WINDOW = 16;

type Mode = 'js' | 'worker';
type Stats = {
  parseMs: number;
  tripMs: number;
  words: number;
  unique: number;
  blocks: number;
  links: number;
};
type Tally = { frames: number; ms: number; dropped: number };

const EMPTY_TALLY: Tally = { frames: 0, ms: 0, dropped: 0 };

export default function MarkdownEditorScreen() {
  const workerRef = useRef<Worker | null>(null);
  const docRef = useRef(buildDocument(DOC_KB));
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const modeRef = useRef<Mode>('js');

  const [mode, setMode] = useState<Mode>('js');
  const [running, setRunning] = useState(SHOWCASE);
  const [fps, setFps] = useState(60);
  const [stats, setStats] = useState<Stats | null>(null);
  const [view, setView] = useState<Block[]>([]);
  const [sent, setSent] = useState(0);
  const [applied, setApplied] = useState(0);
  const [parses, setParses] = useState(0);
  const [tally, setTally] = useState<Record<Mode, Tally>>({
    js: EMPTY_TALLY,
    worker: EMPTY_TALLY,
  });

  const sweep = useRef(new Animated.Value(0)).current;

  /* ------------------------------------------------------------ the worker */

  useEffect(() => {
    const w = new Worker('../workers/markdown');
    workerRef.current = w;

    w.onmessage = (e: any) => {
      const d = e.data;
      if (d?.ready) return;
      // A reply older than one we've already drawn describes a document the
      // user has typed past. Drop it.
      if (d.seq < appliedRef.current) return;
      appliedRef.current = d.seq;
      setApplied(d.seq);
      setParses((p) => p + 1);
      setView(d.view);
      setStats({
        parseMs: d.parseMs,
        tripMs: Date.now() - d.sentAt,
        words: d.words,
        unique: d.unique,
        blocks: d.blocks,
        links: d.links,
      });
    };

    // The worker keeps its own copy of the document. This is the only time the
    // whole thing crosses the boundary; every keystroke after it is one char.
    w.postMessage({
      reset: true,
      text: docRef.current,
      seq: 0,
      sentAt: Date.now(),
    });

    // First paint comes from a local parse so the screen is never empty.
    applyLocal(docRef.current, 0);
    markReady('markdown', 'data');

    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  /** Parses on THIS thread and paints — the "before" case, in full. */
  const applyLocal = (text: string, parseAt: number) => {
    const t0 = Date.now();
    const doc = parseMarkdown(text);
    const parseMs = Date.now() - t0;
    const start = Math.max(0, doc.blocks.length - WINDOW);
    setView(doc.blocks.slice(start, start + WINDOW));
    setStats({
      parseMs,
      tripMs: parseAt ? Date.now() - parseAt : parseMs,
      words: doc.words,
      unique: doc.unique,
      blocks: doc.blocks.length,
      links: doc.links.length,
    });
    appliedRef.current = seqRef.current;
    setApplied(seqRef.current);
    setParses((p) => p + 1);
  };

  /* ------------------------------------------------- the frame-rate monitor */

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let dropped = 0;
    let windowStart = Date.now();
    let lastFrame = windowStart;

    const tick = () => {
      const now = Date.now();
      frames++;

      // A dropped frame is a gap wider than one frame interval — counted from
      // the actual gap, not from "60 minus what we got", so a display that runs
      // at 59 isn't reported as a stutter.
      const gap = now - lastFrame;
      if (gap > 24) dropped += Math.round(gap / 16.67) - 1;
      lastFrame = now;

      // The sweep is driven from here on purpose: it is a JS-thread animation,
      // so it stutters exactly as much as the JS thread does.
      sweep.setValue((now % 1400) / 1400);

      const elapsed = now - windowStart;
      if (elapsed >= 400) {
        // Snapshot before resetting — a functional setState updater runs later,
        // and would otherwise read counters that are already back at zero.
        const f = frames;
        const d = dropped;
        const m = modeRef.current;
        setFps(Math.round((f * 1000) / elapsed));
        setTally((t) => ({
          ...t,
          [m]: {
            frames: t[m].frames + f,
            ms: t[m].ms + elapsed,
            dropped: t[m].dropped + d,
          },
        }));
        frames = 0;
        dropped = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------------------------------------------- the typing driver */

  useEffect(() => {
    if (!running) return;
    let i = 0;
    const id = setInterval(() => {
      // Append one character, like a person typing at the end of the document.
      const ch = TYPED_SENTENCE[i % TYPED_SENTENCE.length] ?? ' ';
      docRef.current += ch;
      i++;
      const seq = ++seqRef.current;
      setSent(seq);

      if (modeRef.current === 'worker') {
        // The edit, not the document — a one-character message.
        workerRef.current?.postMessage({ seq, append: ch, sentAt: Date.now() });
      } else {
        // Same parser, same document — on the thread that also has to draw.
        applyLocal(docRef.current, Date.now());
      }
    }, TYPE_MS);
    return () => clearInterval(id);
  }, [running]);

  /* ------------------------------------------------------ the showcase loop */

  /**
   * Flips where the parse runs. Switching *into* worker mode re-sends the whole
   * document once: the keystrokes typed while the JS thread owned the parse
   * never reached the worker, so its copy is behind by exactly that much.
   */
  const flip = () => {
    const next: Mode = modeRef.current === 'js' ? 'worker' : 'js';
    modeRef.current = next;
    setMode(next);
    if (next === 'worker') {
      workerRef.current?.postMessage({
        reset: true,
        text: docRef.current,
        seq: seqRef.current,
        sentAt: Date.now(),
      });
    }
  };

  useEffect(() => {
    if (!SHOWCASE) return;
    const id = setInterval(flip, MODE_MS);
    return () => clearInterval(id);
  }, []);

  const onWorker = mode === 'worker';
  const coalesced = sent - applied;

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        One parser module, imported by this screen and by the worker. The
        document is {Math.round(docRef.current.length / 1024)}KB and every
        keystroke re-parses all of it.
      </Text>

      <View
        style={[styles.banner, onWorker ? styles.bannerOk : styles.bannerBad]}
      >
        <Text style={styles.bannerText}>
          {onWorker ? 'PARSING IN A WORKER' : 'PARSING ON THE JS THREAD'}
        </Text>
      </View>

      <View style={styles.meter}>
        <View style={styles.track}>
          <Animated.View
            style={[
              styles.pill,
              {
                transform: [
                  {
                    translateX: sweep.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 240],
                    }),
                  },
                ],
              },
            ]}
          />
        </View>
        <View style={styles.fpsBox}>
          <Text style={[styles.fps, fps < 45 && styles.fpsBad]}>{fps}</Text>
          <Text style={styles.fpsLabel}>fps</Text>
        </View>
      </View>

      <View style={styles.grid}>
        <Stat
          label="parse"
          value={stats ? `${Math.round(stats.parseMs)}ms` : '—'}
        />
        <Stat
          label={onWorker ? 'round trip' : 'to paint'}
          value={stats ? `${Math.round(stats.tripMs)}ms` : '—'}
        />
        <Stat label="words" value={stats ? String(stats.words) : '—'} />
        <Stat
          label="index"
          value={stats ? `${(stats.unique / 1000).toFixed(1)}k` : '—'}
        />
      </View>

      <Text style={styles.section}>Live preview — the end of the document</Text>
      {/* Scrollable on purpose: on the JS thread it will not scroll while a
          parse is running, which is the whole complaint in one gesture. */}
      <ScrollView style={styles.preview}>
        {view.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </ScrollView>

      <View style={styles.tally}>
        <TallyRow label="On the JS thread" t={tally.js} bad />
        <TallyRow label="In a worker" t={tally.worker} />
        <Text style={styles.tallyNote}>
          {sent} keystrokes · {parses} parses · {Math.max(0, coalesced)} edits
          waiting
        </Text>
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={flip}>
          <Text style={styles.btnText}>
            Run parse {onWorker ? 'on the JS thread' : 'in the worker'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt]}
          onPress={() => setRunning((r) => !r)}
        >
          <Text style={styles.btnText}>{running ? 'Stop typing' : 'Type'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ----------------------------------------------------------------- pieces */

function BlockView({ block }: { block: Block }) {
  if (block.type === 'hr') return <View style={styles.hr} />;
  if (block.type === 'code') {
    return (
      <View style={styles.code}>
        <Text style={styles.codeText}>{block.text}</Text>
      </View>
    );
  }
  if (block.type === 'h') {
    return (
      <Text style={[styles.h, block.level > 1 && styles.h2]}>
        <Spans spans={block.spans} />
      </Text>
    );
  }
  if (block.type === 'quote') {
    return (
      <Text style={styles.quote}>
        <Spans spans={block.spans} />
      </Text>
    );
  }
  if (block.type === 'li') {
    return (
      <Text style={styles.li}>
        {'•  '}
        <Spans spans={block.spans} />
      </Text>
    );
  }
  return (
    <Text style={styles.p}>
      <Spans spans={block.spans} />
    </Text>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.t === 'strong')
          return (
            <Text key={i} style={styles.strong}>
              {s.v}
            </Text>
          );
        if (s.t === 'em')
          return (
            <Text key={i} style={styles.em}>
              {s.v}
            </Text>
          );
        if (s.t === 'code')
          return (
            <Text key={i} style={styles.inlineCode}>
              {s.v}
            </Text>
          );
        if (s.t === 'link')
          return (
            <Text key={i} style={styles.link}>
              {s.v}
            </Text>
          );
        return <Text key={i}>{s.v}</Text>;
      })}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TallyRow({
  label,
  t,
  bad,
}: {
  label: string;
  t: Tally;
  bad?: boolean;
}) {
  const avg = t.ms ? Math.round((t.frames * 1000) / t.ms) : 0;
  return (
    <View style={styles.tallyRow}>
      <Text style={[styles.tallyLabel, bad && styles.tallyBad]}>{label}</Text>
      <Text style={styles.tallyValue}>
        {avg} fps · {t.dropped} frames dropped
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The app shell pads the top only, so the screen owns its bottom inset —
  // otherwise the buttons sit under the home indicator.
  container: { flex: 1, paddingHorizontal: 16, paddingBottom: 34 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 10 },

  banner: { borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  bannerBad: { backgroundColor: '#c62828' },
  bannerOk: { backgroundColor: '#2e7d32' },
  bannerText: {
    color: 'white',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1.1,
  },

  meter: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  track: {
    flex: 1,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#eceff3',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  pill: { width: 54, height: 14, borderRadius: 7, backgroundColor: '#1565c0' },
  fpsBox: { alignItems: 'center', width: 54 },
  fps: { fontSize: 22, fontWeight: '800', color: '#2e7d32' },
  fpsBad: { color: '#c62828' },
  fpsLabel: { fontSize: 10, color: '#888', marginTop: -2 },

  grid: { flexDirection: 'row', gap: 8, marginTop: 12 },
  stat: {
    flex: 1,
    backgroundColor: '#f2f4f7',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  statValue: { fontSize: 16, fontWeight: '700' },
  statLabel: { fontSize: 10, color: '#777', marginTop: 2 },

  section: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  preview: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e6ec',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  h: { fontSize: 17, fontWeight: '800', marginTop: 8, marginBottom: 4 },
  h2: { fontSize: 15 },
  p: { fontSize: 13, lineHeight: 19, color: '#333', marginBottom: 6 },
  li: { fontSize: 13, lineHeight: 19, color: '#333', marginBottom: 3 },
  quote: {
    fontSize: 13,
    lineHeight: 19,
    color: '#666',
    fontStyle: 'italic',
    borderLeftWidth: 3,
    borderLeftColor: '#d5dae2',
    paddingLeft: 8,
    marginBottom: 6,
  },
  strong: { fontWeight: '800', color: '#111' },
  em: { fontStyle: 'italic' },
  inlineCode: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#c2185b',
    backgroundColor: '#fbe9f0',
  },
  link: { color: '#1565c0' },
  code: {
    backgroundColor: '#f5f7fa',
    borderRadius: 6,
    padding: 8,
    marginBottom: 6,
  },
  codeText: { fontFamily: 'Menlo', fontSize: 11, color: '#37474f' },
  hr: { height: 1, backgroundColor: '#e2e6ec', marginVertical: 8 },

  tally: { marginTop: 12, gap: 3 },
  tallyRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tallyLabel: { fontSize: 12, color: '#2e7d32', fontWeight: '700' },
  tallyBad: { color: '#c62828' },
  tallyValue: { fontSize: 12, color: '#555', fontVariant: ['tabular-nums'] },
  tallyNote: { fontSize: 11, color: '#999', marginTop: 2 },

  row: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 4 },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    flex: 1,
    alignItems: 'center',
  },
  btnAlt: { backgroundColor: '#5c6bc0', flex: 0, paddingHorizontal: 16 },
  btnText: { color: 'white', fontWeight: '600', fontSize: 12 },
});
