import { useEffect, useRef, useState } from 'react';
import { Text, View, StyleSheet, Pressable, ScrollView } from 'react-native';
import { Worker, SharedValue } from '@ammarahmed/react-native-workers';

const COUNT = 6;
const LABELS = [
  'season-01.mp4',
  'dataset.tar.gz',
  'model-weights.bin',
  'photos-2026.zip',
  'podcast-ep-114.m4a',
  'map-tiles.mbtiles',
];

const STATE_NAMES = ['queued', 'downloading', 'paused', 'done', 'cancelled'];
const RUNNING = 1;
const PAUSED = 2;
const DONE = 3;

type Cells = { id: number; progress: SharedValue; state: SharedValue };

export default function DownloadsScreen() {
  const workerRef = useRef<Worker | null>(null);
  const cellsRef = useRef<Cells[]>([]);
  // Progress is SAMPLED, not subscribed — see the render loop below.
  const [rows, setRows] = useState<{ progress: number; state: number }[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [writes, setWrites] = useState(0);
  const [frames, setFrames] = useState(0);
  const [ready, setReady] = useState(false);

  const logEvent = (s: string) => setEvents((e) => [s, ...e].slice(0, 6));

  useEffect(() => {
    const w = new Worker('../workers/downloads');
    workerRef.current = w;

    w.registerModule('app', {
      onFinished(id: number) {
        logEvent(`worker → host: ${LABELS[id]} finished`);
      },
    });

    let alive = true;
    let loop: any = null;

    (async () => {
      await w.ready('downloads', 5000);
      // A namespace unique to this mount. Shared cells are process-wide and
      // survive a JS reload, so reusing fixed names would inherit the previous
      // run's progress.
      const ns = 'dl-' + Date.now().toString(36);
      const created: any[] = await (w.module('downloads') as any).create(
        ns,
        COUNT
      );
      if (!alive) return;

      // The host opens the SAME cells by name. Nothing is copied: both runtimes
      // now point at one piece of memory each.
      cellsRef.current = created.map((c) => ({
        id: c.id,
        progress: new SharedValue(c.progress, 0),
        state: new SharedValue(c.state, 0),
      }));
      setReady(true);
      // Kick off immediately so the screen shows the point on arrival. Tapping a
      // row pauses/resumes it, and the buttons drive them all.
      (w.module('downloads') as any).startAll();

      // Sampling loop. The worker writes ~750 times a second across 6 cells;
      // we read whatever is current when we happen to render. Subscribing to
      // progress would mean thousands of callbacks a second for 60 useful
      // repaints — this is the pattern that makes shared memory worth it.
      let ticks = 0;
      loop = setInterval(() => {
        setRows(
          cellsRef.current.map((c) => ({
            progress: c.progress.value,
            state: c.state.value,
          }))
        );
        setFrames((f) => f + 1);
        // The write count is the one thing that ISN'T shared, so it needs an
        // actual call. Sampled a few times a second, not per frame.
        if (ticks++ % 20 === 0) {
          (w.module('downloads') as any).stats().then((s: any) => {
            if (alive) setWrites(s.writes);
          });
        }
      }, 16);
    })();

    return () => {
      alive = false;
      if (loop) clearInterval(loop);
      // Ask the worker to drop its cells before we tear it down, otherwise the
      // names leak for the lifetime of the process.
      (w.module('downloads') as any)?.reset?.();
      w.terminate();
    };
  }, []);

  const call = async (method: string, ...args: any[]) => {
    const w = workerRef.current;
    if (!w) return;
    await (w.module('downloads') as any)[method](...args);
    const s: any = await (w.module('downloads') as any).stats();
    setWrites(s.writes);
  };

  const anyRunning = rows.some((r) => r.state === RUNNING);

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        Six transfers run in a worker. Progress lives in shared cells the worker
        writes and this screen reads — no message per tick. State changes are
        rare, so those come back as real calls.
      </Text>

      <View style={styles.row}>
        <Pressable
          style={[styles.btn, !ready && styles.btnOff]}
          disabled={!ready}
          onPress={() => call('startAll')}
        >
          <Text style={styles.btnText}>Start all</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt]}
          onPress={() => rows.forEach((_, i) => call('pause', i))}
        >
          <Text style={styles.btnText}>Pause all</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt]}
          onPress={() => rows.forEach((_, i) => call('cancel', i))}
        >
          <Text style={styles.btnText}>Cancel all</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list}>
        {rows.map((r, i) => (
          <Pressable
            key={i}
            style={styles.item}
            onPress={() => call(r.state === RUNNING ? 'pause' : 'start', i)}
          >
            <View style={styles.itemHead}>
              <Text style={styles.itemName}>{LABELS[i]}</Text>
              <Text style={styles.itemPct}>
                {(r.progress / 10).toFixed(1)}%
              </Text>
            </View>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${r.progress / 10}%` },
                  r.state === DONE && styles.fillDone,
                  r.state === PAUSED && styles.fillPaused,
                ]}
              />
            </View>
            <Text style={styles.itemState}>{STATE_NAMES[r.state]}</Text>
          </Pressable>
        ))}
        {!ready && <Text style={styles.dim}>starting worker…</Text>}
      </ScrollView>

      <Text style={styles.section}>Cost</Text>
      <Text style={styles.dim}>
        shared writes by the worker: {writes} · frames rendered here: {frames}
      </Text>
      <Text style={styles.dim}>
        {anyRunning ? 'running — ' : ''}the two numbers diverge on purpose: the
        worker writes far more often than the UI needs to draw.
      </Text>

      {events.map((e, i) => (
        <Text key={i} style={styles.event}>
          {e}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  btnAlt: { backgroundColor: '#5c6bc0' },
  btnOff: { opacity: 0.4 },
  btnText: { color: 'white', fontWeight: '600', fontSize: 13 },
  list: { flex: 1, marginTop: 4 },
  item: { marginBottom: 12 },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between' },
  itemName: { fontSize: 13, fontWeight: '600' },
  itemPct: { fontSize: 12, color: '#666', fontVariant: ['tabular-nums'] },
  track: {
    height: 8,
    backgroundColor: '#e6e8eb',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 4,
  },
  fill: { height: 8, backgroundColor: '#1565c0' },
  fillDone: { backgroundColor: '#2e7d32' },
  fillPaused: { backgroundColor: '#b0863a' },
  itemState: { fontSize: 11, color: '#888', marginTop: 3 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  dim: { fontSize: 12, color: '#777', lineHeight: 18 },
  event: {
    fontSize: 11,
    color: '#2e7d32',
    fontFamily: 'Courier',
    marginTop: 2,
  },
});
