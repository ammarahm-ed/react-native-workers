import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Animated,
  Dimensions,
  findNodeHandle,
  FlatList,
  Image,
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
import { FEED_ART } from '../assets/feed';
import {
  ART_COUNT,
  buildFeed,
  compact,
  FEED_COUNT,
  MAX_LINES,
  rowHeight,
  type FeedItem,
} from '../workers/helpers/feed';

/**
 * The same live feed, twice, side by side.
 *
 * LEFT is what everyone ships: a FlatList, rows re-rendered by React as the
 * engagement events come in off the socket, scrolled from JS.
 *
 * RIGHT is a UICollectionView built inside a UIWorker. Its cells are React
 * views — a pool of JSX templates — but they are recycled and repainted by the
 * worker, from shared memory, on the main thread. React renders it exactly once.
 *
 * Both lists show the same 5,000 rows and the same counters, and both are
 * scrolled automatically so the recording needs no hands.
 */

/** Auto-run both lists on mount, for recording. */
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
/** Scroll speed in points per second — a sustained fling, identical on both
 *  sides because one loop in the worker scrolls them both. */
const SPEED = 2600;

const COL_W = Math.floor((Dimensions.get('window').width - 40) / 2);

export default function FeedScreen() {
  const items = useMemo(() => buildFeed(FEED_COUNT), []);
  const [components, setComponents] = useState<Record<
    string,
    ComponentType<any>
  > | null>(null);

  /* ---------------------------------------------------------- the socket */

  // Live counts as the React side has to hold them: plain JS data the JS thread
  // owns, refreshed by messages from the producer worker.
  const counts = useRef<Map<number, [number, number]>>(new Map()).current;
  const [version, setVersion] = useState(0);
  const dirty = useRef(false);
  const events = useRef(0);
  const renders = useRef(0);

  const [jsFps, setJsFps] = useState(0);
  const [rate, setRate] = useState(0);
  const [rendersPerSec, setRendersPerSec] = useState(0);
  const [uiRate, setUiRate] = useState(0);
  const [painted, setPainted] = useState(0);

  useEffect(() => {
    const producer = new Worker('../workers/feedsource');
    producer.onmessage = (e: any) => {
      const d = e.data;
      if (d?.ready) {
        producer.postMessage({ start: true });
        markReady('feed', 'data');
        return;
      }
      const flat: number[] = JSON.parse(d.frame);
      for (let i = 0; i < flat.length; i += 3) {
        counts.set(flat[i]!, [flat[i + 1]!, flat[i + 2]!]);
      }
      events.current += flat.length / 3;
      dirty.current = true;
    };
    return () => {
      producer.postMessage({ stop: true });
      producer.terminate();
    };
  }, [counts]);

  /* ------------------------------------------------- the JS thread's frame */

  // The left column's dot. `useNativeDriver: false` on purpose: this is the
  // JS thread's animation, and it moves as well as the JS thread is doing.
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

  const listRef = useRef<FlatList<FeedItem> | null>(null);
  const ready = components != null;
  useEffect(() => {
    // Both lists start from row 0 at the same moment, so the only thing that
    // differs between the columns is how smoothly they get there.
    if (!SHOWCASE || !ready) return;
    let raf = 0;
    let frames = 0;
    let since = Date.now();

    const tick = () => {
      const now = Date.now();
      frames++;

      // Paint the counts that arrived since the last frame. Every visible row
      // re-renders; this is the work the worker list does not do.
      if (dirty.current) {
        dirty.current = false;
        renders.current++;
        setVersion((v) => v + 1);
      }

      if (now - since >= 500) {
        const secs = (now - since) / 1000;
        setJsFps(Math.round(frames / secs));
        setRate(Math.round(events.current / secs));
        setRendersPerSec(Math.round(renders.current / secs));
        setUiRate(new SharedValue<number>('feed.rate', 0).value);
        setPainted(new SharedValue<number>('feed.patched', 0).value);
        frames = 0;
        events.current = 0;
        renders.current = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

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
        // Let the worker scroll the React list too. Both columns then move at
        // the same speed from the same main-thread loop, so the only thing
        // being compared is how each one keeps its rows up to date.
        const tag = findNodeHandle(listRef.current);
        if (tag != null) await (w.module('feed') as any).driveScroll(tag);
      } catch {
        // The screen still shows the FlatList side.
      }
    })();
    return () => {
      alive = false;
      w.terminate();
    };
  }, []);

  // Rows are memoized on primitives, so only the rows whose numbers actually
  // changed re-render — the version any reviewer would write.
  const renderRow = useCallback(
    ({ item }: { item: FeedItem }) => {
      const live = counts.get(item.id);
      return (
        <Row item={item} likes={live?.[0] ?? 0} replies={live?.[1] ?? 0} />
      );
    },
    [counts]
  );

  const WorkerFeed = components?.WorkerFeed;
  const WorkerText = components?.WorkerText;
  const WorkerArt = components?.WorkerArt;
  const WorkerPulse = components?.WorkerPulse;

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        {FEED_COUNT.toLocaleString()} rows, and a producer worker pushing{' '}
        <Text style={styles.bold}>2,000 engagement updates a second</Text> into
        shared memory. Both lists show the same feed and scroll at the same
        speed.
      </Text>

      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.colTitle}>FlatList · React</Text>
          <Text style={styles.colSub}>rendered on the JS thread</Text>
          <View style={styles.chipRow}>
            <Chip label={`${jsFps} fps`} tone={jsFps >= 55 ? 'good' : 'bad'} />
            <Chip label={`${rendersPerSec} renders/s`} />
          </View>
          <View style={styles.track}>
            <Animated.View
              style={[
                styles.dot,
                styles.dotJs,
                {
                  transform: [
                    {
                      translateX: pulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, COL_W - 10],
                      }),
                    },
                  ],
                },
              ]}
            />
          </View>
          <View style={styles.listBox}>
            <FlatList
              ref={listRef}
              data={items}
              extraData={version}
              keyExtractor={keyOf}
              initialNumToRender={8}
              renderItem={renderRow}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>

        <View style={styles.column}>
          <Text style={styles.colTitle}>UICollectionView · UIWorker</Text>
          <Text style={styles.colSub}>recycled + repainted off-thread</Text>
          <View style={styles.chipRow}>
            <Chip
              label={`${uiRate} Hz loop`}
              tone={uiRate >= 55 ? 'good' : 'bad'}
            />
            <Chip label={`${painted} repaints/s`} />
          </View>
          <View style={styles.track}>
            {WorkerPulse ? (
              <WorkerPulse
                hex="#1e7d34"
                travel={COL_W - 10}
                style={styles.dot}
              />
            ) : null}
          </View>
          <View style={styles.listBox}>
            {WorkerFeed && WorkerText && WorkerArt ? (
              <WorkerFeed
                style={styles.list}
                itemWidth={COL_W}
                shapes={SLOT_LINES}
                heights={SHAPE_HEIGHTS}
                speed={SPEED}
                running={SHOWCASE}
              >
                {/* The cell templates. Written in JSX, laid out by Yoga once,
                    then owned by the worker: it parks them in dequeued cells
                    and writes the row's text straight into the labels. */}
                {SLOT_LINES.map((lines, i) => {
                  const cell = shapeStyles(lines);
                  return (
                    <View key={i} style={cell.slot} collapsable={false}>
                      {/* The chrome is plain React: a card, a border, a
                          shadow, three pill backgrounds. Twenty templates get
                          mounted and laid out by Yoga once — five of each row
                          height — and then React is done with this list. */}
                      <View style={cell.card} />
                      <View style={[cell.pill, cell.pillLikes]} />
                      <View style={[cell.pill, cell.pillReplies]} />
                      <View style={[cell.pill, cell.pillReposts]} />
                      <Text style={cell.verified}>✓</Text>
                      <WorkerArt
                        slot={i}
                        field="art"
                        radius={10}
                        style={cell.art}
                      />
                      <WorkerArt
                        slot={i}
                        field="preview"
                        radius={6}
                        style={cell.preview}
                      />
                      <WorkerArt
                        slot={i}
                        field="face0"
                        radius={7}
                        style={[cell.face, cell.face0]}
                      />
                      <WorkerArt
                        slot={i}
                        field="face1"
                        radius={7}
                        style={[cell.face, cell.face1]}
                      />
                      <WorkerArt
                        slot={i}
                        field="face2"
                        radius={7}
                        style={[cell.face, cell.face2]}
                      />
                      <WorkerText
                        slot={i}
                        field="author"
                        size={12}
                        weight="bold"
                        hex="#111111"
                        style={cell.author}
                      />
                      <WorkerText
                        slot={i}
                        field="meta"
                        size={9}
                        hex="#8a9099"
                        style={cell.meta}
                      />
                      <WorkerText
                        slot={i}
                        field="topic"
                        size={9}
                        weight="bold"
                        hex="#1565c0"
                        style={cell.topic}
                      />
                      <WorkerText
                        slot={i}
                        field="body"
                        size={10}
                        lines={lines}
                        hex="#333333"
                        style={cell.body}
                      />
                      <WorkerText
                        slot={i}
                        field="detail"
                        size={10}
                        hex="#6b7280"
                        style={cell.detail}
                      />
                      <WorkerText
                        slot={i}
                        field="likes"
                        size={10}
                        hex="#c2185b"
                        style={cell.likes}
                      />
                      <WorkerText
                        slot={i}
                        field="replies"
                        size={10}
                        hex="#1565c0"
                        style={cell.replies}
                      />
                      <WorkerText
                        slot={i}
                        field="reposts"
                        size={10}
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
        </View>
      </View>

      <Text style={styles.note}>
        Left: every event is a message the JS thread has to receive, store and
        re-render. Right: the events never leave shared memory — the worker
        reads the rows that are on screen and assigns the labels directly, so
        React renders this list once and never again.
      </Text>
      <Text style={styles.rate}>
        {rate.toLocaleString()} events/s delivered
      </Text>
    </View>
  );
}

const keyOf = (item: FeedItem) => String(item.id);

/** The React row — the same card, the same twenty-odd views, and a height
 *  that comes out of the text, which is why this list has no `getItemLayout`. */
const Row = memo(function Row({
  item,
  likes,
  replies,
}: {
  item: FeedItem;
  likes: number;
  replies: number;
}) {
  const cell = shapeStyles(item.lines);
  return (
    <View style={cell.row}>
      <View style={cell.card} />
      <View style={[cell.pill, cell.pillLikes]} />
      <View style={[cell.pill, cell.pillReplies]} />
      <View style={[cell.pill, cell.pillReposts]} />
      <Text style={cell.verified}>✓</Text>
      <Image source={FEED_ART[item.art]} style={cell.art} />
      <Image source={FEED_ART[item.preview]} style={cell.preview} />
      <Image
        source={FEED_ART[(item.art + 1) % ART_COUNT]}
        style={[cell.face, cell.face0]}
      />
      <Image
        source={FEED_ART[(item.art + 7) % ART_COUNT]}
        style={[cell.face, cell.face1]}
      />
      <Image
        source={FEED_ART[(item.art + 13) % ART_COUNT]}
        style={[cell.face, cell.face2]}
      />
      <Text style={cell.author} numberOfLines={1}>
        {item.author}
      </Text>
      <Text style={cell.meta} numberOfLines={1}>
        {item.handle} · {item.age}m
      </Text>
      <Text style={cell.topic}>{item.topic}</Text>
      <Text style={cell.body} numberOfLines={item.lines}>
        {item.body}
      </Text>
      <Text style={cell.detail} numberOfLines={1}>
        {item.detail}
      </Text>
      <Text style={cell.likes}>♥ {compact(likes)}</Text>
      <Text style={cell.replies}>↩ {compact(replies)}</Text>
      <Text style={cell.reposts}>⇅ {compact(Math.floor(likes / 7))}</Text>
    </View>
  );
});

function Chip({ label, tone }: { label: string; tone?: 'good' | 'bad' }) {
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
  columns: { flexDirection: 'row', gap: 8 },
  column: { width: COL_W },
  colTitle: { fontSize: 12, fontWeight: '700', color: '#111' },
  colSub: { fontSize: 10, color: '#8a9099', marginTop: 1 },
  chipRow: { flexDirection: 'row', gap: 6, marginTop: 6, marginBottom: 4 },
  // The same 10pt dot on the same track in both columns. One is moved by the
  // JS thread, the other by the worker's loop on the main thread.
  track: { height: 12, justifyContent: 'center', marginBottom: 4 },
  dot: {
    position: 'absolute',
    left: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotJs: { backgroundColor: '#c62828' },
  listBox: {
    height: 450,
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

  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 12 },
  rate: { fontSize: 11, color: '#1565c0', marginTop: 6, fontWeight: '600' },
});

/**
 * One row, and one worker cell template: the same box, the same positions, for
 * a given number of body lines. Every leaf carries an explicit height — a
 * worker-defined component has no shadow node to measure itself, so Yoga only
 * knows the box you give it.
 */
const SHEETS = new Map<number, any>();
function shapeStyles(lines: number) {
  const cached = SHEETS.get(lines);
  if (cached) return cached;
  const height = rowHeight(lines);
  const bodyH = lines * 14;
  const detailTop = 56 + bodyH + 2;
  const previewTop = detailTop + 16;
  const footTop = height - 38;
  const sheet = StyleSheet.create({
    row: { width: COL_W, height },
    slot: { position: 'absolute', left: 0, top: 0, width: COL_W, height },
    card: {
      position: 'absolute',
      left: 4,
      right: 4,
      top: 4,
      bottom: 6,
      borderRadius: 12,
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#eceff3',
      shadowColor: '#0b1220',
      shadowOpacity: 0.06,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
    },
    pill: {
      position: 'absolute',
      top: footTop - 2,
      height: 18,
      borderRadius: 9,
      backgroundColor: '#f4f6f8',
    },
    pillLikes: { left: 52, width: 42 },
    pillReplies: { left: 96, width: 40 },
    pillReposts: { left: 138, width: 34 },
    verified: {
      position: 'absolute',
      right: 10,
      top: 12,
      width: 12,
      height: 13,
      fontSize: 9,
      color: '#1d9bf0',
      fontWeight: '700',
    },
    art: {
      position: 'absolute',
      left: 12,
      top: 14,
      width: 40,
      height: 40,
      borderRadius: 10,
    },
    preview: {
      position: 'absolute',
      left: 12,
      top: previewTop,
      right: 12,
      height: 24,
      borderRadius: 6,
    },
    face: {
      position: 'absolute',
      top: footTop,
      width: 14,
      height: 14,
      borderRadius: 7,
    },
    face0: { left: 12 },
    face1: { left: 22 },
    face2: { left: 32 },
    author: {
      position: 'absolute',
      left: 60,
      top: 14,
      right: 26,
      height: 15,
      fontSize: 12,
      fontWeight: '700',
      color: '#111',
    },
    meta: {
      position: 'absolute',
      left: 60,
      top: 31,
      width: 62,
      height: 12,
      fontSize: 9,
      color: '#8a9099',
    },
    topic: {
      position: 'absolute',
      right: 10,
      top: 31,
      width: 42,
      height: 12,
      fontSize: 9,
      fontWeight: '700',
      color: '#1565c0',
    },
    body: {
      position: 'absolute',
      left: 12,
      top: 56,
      right: 12,
      height: bodyH,
      fontSize: 10,
      lineHeight: 14,
      color: '#333',
    },
    detail: {
      position: 'absolute',
      left: 12,
      top: detailTop,
      right: 12,
      height: 14,
      fontSize: 10,
      color: '#6b7280',
    },
    likes: {
      position: 'absolute',
      left: 58,
      top: footTop,
      width: 40,
      height: 14,
      fontSize: 10,
      color: '#c2185b',
    },
    replies: {
      position: 'absolute',
      left: 100,
      top: footTop,
      width: 38,
      height: 14,
      fontSize: 10,
      color: '#1565c0',
    },
    reposts: {
      position: 'absolute',
      left: 142,
      top: footTop,
      width: 34,
      height: 14,
      fontSize: 10,
      color: '#2e7d32',
    },
  });
  SHEETS.set(lines, sheet);
  return sheet;
}
