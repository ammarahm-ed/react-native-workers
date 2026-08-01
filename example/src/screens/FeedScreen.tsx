import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Animated,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SharedValue,
  UIWorker,
  Worker,
} from '@ammarahmed/react-native-workers';
import {
  createWorkerComponent,
  type Descriptor,
} from '../native-components/createWorkerComponent';
import { markReady } from '../devReady';
import { FEED_COUNT, MAX_LINES, rowHeight } from '../workers/helpers/feed';

/**
 * A live feed — 20,000 rows of variable height, ~2,000 engagement updates a
 * second — rendered by a UICollectionView that lives inside a UIWorker.
 *
 * The cells are React's own views: this screen renders a pool of cell
 * templates in JSX, and the worker parks one in each dequeued cell and writes
 * the row into its labels itself. React renders the list exactly once.
 *
 * Nothing about the list needs this thread, and the plainest way to show that
 * is to take the thread away: every few seconds the screen blocks its own JS
 * thread for over a second. The counters below freeze, the red dot stops, and
 * the list keeps scrolling and keeps ticking.
 */

/** Auto-run the scroll and the blocking loop on mount, for recording. */
const SHOWCASE = true;
/** Cell templates React mounts per row shape, for the worker to recycle. Rows
 *  come in four heights, so the pool does too. */
const SLOTS_PER_SHAPE = 5;
const SLOTS = SLOTS_PER_SHAPE * MAX_LINES;
/** Body lines of the template in each slot, in React child order. */
const SLOT_LINES = Array.from(
  { length: SLOTS },
  (_, i) => Math.floor(i / SLOTS_PER_SHAPE) + 1
);
/** The height of each shape, indexed by lines - 1. */
const SHAPE_HEIGHTS = Array.from({ length: MAX_LINES }, (_, i) =>
  rowHeight(i + 1)
);
/** Scroll speed in points per second — a sustained fling. */
const SPEED = 1400;
/** How long the JS thread is blocked, and how often. */
const BLOCK_MS = 1300;
const BLOCK_EVERY_MS = 3200;

const ROW_W = Dimensions.get('window').width - 32;

export default function FeedScreen() {
  const [components, setComponents] = useState<Record<
    string,
    ComponentType<any>
  > | null>(null);

  const [jsFps, setJsFps] = useState(0);
  const [uiRate, setUiRate] = useState(0);
  const [painted, setPainted] = useState(0);
  const [events, setEvents] = useState(0);
  const [blocked, setBlocked] = useState(false);

  /* ------------------------------------------------------- the producer */

  useEffect(() => {
    const producer = new Worker('../workers/feedsource');
    producer.onmessage = (e: any) => {
      if (e.data?.ready) {
        producer.postMessage({ start: true });
        markReady('feed', 'data');
      }
    };
    return () => {
      producer.postMessage({ stop: true });
      producer.terminate();
    };
  }, []);

  /* ------------------------------------------------------- the UIWorker */

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    const w = new UIWorker('../workers/feedlist', { nativeModules: true });
    (async () => {
      try {
        await w.ready('nativecomponents', 8000);
        const descriptors: Descriptor[] = await (
          w.module('nativecomponents') as any
        ).list();
        if (!alive) return;
        const resolved: Record<string, ComponentType<any>> = {};
        for (const d of descriptors)
          resolved[d.name] = createWorkerComponent(d);
        setComponents(resolved);
      } catch {
        // The screen still renders, with a note in place of the list.
      }
    })();
    return () => {
      alive = false;
      w.terminate();
    };
  }, []);

  /* ------------------------------------------------- this thread's health */

  // A plain JS-driven animation: `useNativeDriver: false` on purpose, because
  // the point is to show what the JS thread is managing to do.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // This thread's frame rate, and the worker's numbers, twice a second.
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let since = Date.now();
    const tick = () => {
      frames++;
      const now = Date.now();
      if (now - since >= 500) {
        const secs = (now - since) / 1000;
        setJsFps(Math.round(frames / secs));
        setUiRate(new SharedValue<number>('feed.rate', 0).value);
        setPainted(new SharedValue<number>('feed.patched', 0).value);
        setEvents(new SharedValue<number>('feed.events', 0).value);
        frames = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Take the JS thread away, on a timer. This is the whole proof: a busy loop
  // here cannot be scheduled around and stops every single thing React can do,
  // including the numbers above.
  useEffect(() => {
    if (!SHOWCASE) return;
    let stopped = false;
    let timer: any = null;

    const schedule = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        setBlocked(true);
        // A beat later, so the banner is on screen before the thread goes.
        timer = setTimeout(() => {
          const until = Date.now() + BLOCK_MS;
          while (Date.now() < until) {
            // Deliberately nothing. This is the JS thread, gone.
          }
          setBlocked(false);
          schedule();
        }, 80);
      }, BLOCK_EVERY_MS);
    };
    schedule();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const WorkerFeed = components?.WorkerFeed;
  const WorkerText = components?.WorkerText;
  const WorkerArt = components?.WorkerArt;
  const WorkerPulse = components?.WorkerPulse;

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        {FEED_COUNT.toLocaleString()} rows of varying height in a{' '}
        <Text style={styles.bold}>UICollectionView built inside a worker</Text>,
        and a second worker writing{' '}
        <Text style={styles.bold}>2,000 updates a second</Text> into shared
        memory. React rendered this list once.
      </Text>

      <View style={styles.chipRow}>
        <Chip label={`JS ${jsFps} fps`} tone={blocked ? 'bad' : 'idle'} />
        <Chip label={`worker ${uiRate} Hz`} tone="good" />
        <Chip label={`${painted} repaints/s`} />
        <Chip label={`${(events / 1000).toFixed(1)}k events/s`} />
      </View>

      {/* The same 10pt dot, twice: one moved by the JS thread, one moved by
          the worker's own loop. When the banner turns red, only one of them
          is still moving. */}
      <View style={styles.tracks}>
        <View style={styles.track}>
          <View style={styles.rail} />
          <Text style={styles.trackLabel}>JS thread</Text>
          <Animated.View
            style={[
              styles.dot,
              styles.dotJs,
              {
                transform: [
                  {
                    translateX: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, ROW_W - 90],
                    }),
                  },
                ],
              },
            ]}
          />
        </View>
        <View style={styles.track}>
          <View style={styles.rail} />
          <Text style={styles.trackLabel}>worker</Text>
          {WorkerPulse ? (
            <WorkerPulse hex="#1e7d34" travel={ROW_W - 90} style={styles.dot} />
          ) : null}
        </View>
      </View>

      <View style={[styles.banner, blocked && styles.bannerBlocked]}>
        <Text style={[styles.bannerText, blocked && styles.bannerTextBlocked]}>
          {blocked
            ? `JS thread blocked for ${(BLOCK_MS / 1000).toFixed(1)}s — the list does not care`
            : 'JS thread free · blocking it again in a moment'}
        </Text>
      </View>

      <View style={styles.listBox}>
        {WorkerFeed && WorkerText && WorkerArt ? (
          <WorkerFeed
            style={styles.list}
            itemWidth={ROW_W}
            shapes={SLOT_LINES}
            heights={SHAPE_HEIGHTS}
            speed={SPEED}
            running={SHOWCASE}
          >
            {/* The cell templates. The chrome is plain React — a card, a
                border, a shadow, three pill backgrounds — mounted once per
                template and never rendered again. Only the fields below it
                change, and the worker writes those itself. */}
            {SLOT_LINES.map((lines, i) => {
              const cell = shapeStyles(lines);
              return (
                <View key={i} style={cell.slot} collapsable={false}>
                  <View style={cell.card} />
                  <View style={[cell.pill, cell.pillLikes]} />
                  <View style={[cell.pill, cell.pillReplies]} />
                  <View style={[cell.pill, cell.pillReposts]} />
                  <Text style={cell.verified}>✓</Text>
                  <WorkerArt
                    slot={i}
                    field="art"
                    radius={12}
                    style={cell.art}
                  />
                  <WorkerArt
                    slot={i}
                    field="preview"
                    radius={8}
                    style={cell.preview}
                  />
                  <WorkerArt
                    slot={i}
                    field="face0"
                    radius={9}
                    style={[cell.face, cell.face0]}
                  />
                  <WorkerArt
                    slot={i}
                    field="face1"
                    radius={9}
                    style={[cell.face, cell.face1]}
                  />
                  <WorkerArt
                    slot={i}
                    field="face2"
                    radius={9}
                    style={[cell.face, cell.face2]}
                  />
                  <WorkerText
                    slot={i}
                    field="author"
                    size={14}
                    weight="bold"
                    hex="#111111"
                    style={cell.author}
                  />
                  <WorkerText
                    slot={i}
                    field="meta"
                    size={11}
                    hex="#8a9099"
                    style={cell.meta}
                  />
                  <WorkerText
                    slot={i}
                    field="topic"
                    size={11}
                    weight="bold"
                    hex="#1565c0"
                    style={cell.topic}
                  />
                  <WorkerText
                    slot={i}
                    field="body"
                    size={12}
                    lines={lines}
                    hex="#333333"
                    style={cell.body}
                  />
                  <WorkerText
                    slot={i}
                    field="detail"
                    size={11}
                    hex="#6b7280"
                    style={cell.detail}
                  />
                  <WorkerText
                    slot={i}
                    field="likes"
                    size={11}
                    hex="#c2185b"
                    style={cell.likes}
                  />
                  <WorkerText
                    slot={i}
                    field="replies"
                    size={11}
                    hex="#1565c0"
                    style={cell.replies}
                  />
                  <WorkerText
                    slot={i}
                    field="reposts"
                    size={11}
                    hex="#2e7d32"
                    style={cell.reposts}
                  />
                </View>
              );
            })}
          </WorkerFeed>
        ) : (
          <Text style={styles.waiting}>
            {Platform.OS === 'ios' ? 'starting worker…' : 'iOS only'}
          </Text>
        )}
      </View>

      <Text style={styles.note}>
        The counters, the scroll and the recycling all run on the main thread,
        out of shared memory. Nothing here is a message, and nothing here waits
        for React.
      </Text>
    </View>
  );
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone?: 'good' | 'bad' | 'idle';
}) {
  return (
    <View
      style={[
        styles.chip,
        tone === 'good' && styles.chipGood,
        tone === 'bad' && styles.chipBad,
      ]}
    >
      <Text
        style={[
          styles.chipText,
          tone === 'good' && styles.chipTextGood,
          tone === 'bad' && styles.chipTextBad,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 10 },
  bold: { fontWeight: '700', color: '#333' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tracks: { gap: 4, marginBottom: 8 },
  track: { height: 14, justifyContent: 'center' },
  rail: {
    position: 'absolute',
    left: 0,
    width: ROW_W - 80,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#e8ebef',
  },
  trackLabel: {
    position: 'absolute',
    right: 0,
    fontSize: 9,
    color: '#9aa0a6',
  },
  dot: {
    position: 'absolute',
    left: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotJs: { backgroundColor: '#c62828' },
  banner: {
    borderRadius: 8,
    backgroundColor: '#eef1f4',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  bannerBlocked: { backgroundColor: '#fdecea' },
  bannerText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  bannerTextBlocked: { color: '#c62828' },
  listBox: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: '#f7f8fa',
    overflow: 'hidden',
  },
  list: { flex: 1 },
  waiting: { fontSize: 11, color: '#9aa0a6', padding: 10 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: '#eceff1',
  },
  chipGood: { backgroundColor: '#e6f4ea' },
  chipBad: { backgroundColor: '#fdecea' },
  chipText: { fontSize: 10, color: '#333', fontWeight: '600' },
  chipTextGood: { color: '#1e7d34' },
  chipTextBad: { color: '#c62828' },
  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 10 },
});

/**
 * One worker cell template, for a given number of body lines. Every leaf
 * carries an explicit height — a worker-defined component has no shadow node
 * to measure itself, so Yoga only knows the box you give it.
 */
const SHEETS = new Map<number, any>();
function shapeStyles(lines: number) {
  const cached = SHEETS.get(lines);
  if (cached) return cached;
  const height = rowHeight(lines);
  const bodyH = lines * 17;
  const detailTop = 70 + bodyH + 4;
  const previewTop = detailTop + 20;
  const footTop = height - 44;
  const sheet = StyleSheet.create({
    slot: { position: 'absolute', left: 0, top: 0, width: ROW_W, height },
    card: {
      position: 'absolute',
      left: 4,
      right: 4,
      top: 4,
      bottom: 8,
      borderRadius: 14,
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#eceff3',
      shadowColor: '#0b1220',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    pill: {
      position: 'absolute',
      top: footTop - 3,
      height: 22,
      borderRadius: 11,
      backgroundColor: '#f4f6f8',
    },
    pillLikes: { left: 82, width: 56 },
    pillReplies: { left: 142, width: 52 },
    pillReposts: { left: 198, width: 52 },
    verified: {
      position: 'absolute',
      right: 82,
      top: 18,
      width: 14,
      height: 16,
      fontSize: 11,
      color: '#1d9bf0',
      fontWeight: '700',
    },
    art: {
      position: 'absolute',
      left: 14,
      top: 16,
      width: 52,
      height: 52,
      borderRadius: 12,
    },
    preview: {
      position: 'absolute',
      left: 14,
      top: previewTop,
      right: 14,
      height: 34,
      borderRadius: 8,
    },
    face: {
      position: 'absolute',
      top: footTop,
      width: 18,
      height: 18,
      borderRadius: 9,
    },
    face0: { left: 14 },
    face1: { left: 27 },
    face2: { left: 40 },
    author: {
      position: 'absolute',
      left: 78,
      top: 17,
      right: 100,
      height: 18,
      fontSize: 14,
      fontWeight: '700',
      color: '#111',
    },
    meta: {
      position: 'absolute',
      left: 78,
      top: 38,
      width: 160,
      height: 14,
      fontSize: 11,
      color: '#8a9099',
    },
    topic: {
      position: 'absolute',
      right: 14,
      top: 18,
      width: 64,
      height: 14,
      fontSize: 11,
      fontWeight: '700',
      color: '#1565c0',
    },
    body: {
      position: 'absolute',
      left: 14,
      top: 70,
      right: 14,
      height: bodyH,
      fontSize: 12,
      lineHeight: 17,
      color: '#333',
    },
    detail: {
      position: 'absolute',
      left: 14,
      top: detailTop,
      right: 14,
      height: 16,
      fontSize: 11,
      color: '#6b7280',
    },
    likes: {
      position: 'absolute',
      left: 90,
      top: footTop + 1,
      width: 52,
      height: 16,
      fontSize: 11,
      color: '#c2185b',
    },
    replies: {
      position: 'absolute',
      left: 150,
      top: footTop + 1,
      width: 48,
      height: 16,
      fontSize: 11,
      color: '#1565c0',
    },
    reposts: {
      position: 'absolute',
      left: 206,
      top: footTop + 1,
      width: 48,
      height: 16,
      fontSize: 11,
      color: '#2e7d32',
    },
  });
  SHEETS.set(lines, sheet);
  return sheet;
}
