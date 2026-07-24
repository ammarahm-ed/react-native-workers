import { useEffect, useRef, useState } from 'react';
import { Text, View, StyleSheet, Pressable } from 'react-native';
import { Worker, SharedBuffer } from '@ammarahmed/react-native-workers';

const CAPACITY = 512; // samples kept in the ring
const HEADER = 2; // [cursor, producerHz]
const BARS = 64; // waveform columns drawn
const RATES = [60, 200, 1000];

export default function SensorScreen() {
  const workerRef = useRef<Worker | null>(null);
  const bufRef = useRef<SharedBuffer | null>(null);
  const viewRef = useRef<Float32Array | null>(null);
  const nameRef = useRef<string | null>(null);

  const [bars, setBars] = useState<number[]>([]);
  const [produced, setProduced] = useState(0);
  const [producerHz, setProducerHz] = useState(0);
  const [readsPerSec, setReadsPerSec] = useState(0);
  const [hz, setHz] = useState(200);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const name = 'sensor-' + Date.now().toString(36);
    nameRef.current = name;

    const w = new Worker('../workers/sensor');
    workerRef.current = w;

    let alive = true;
    let loop: any = null;
    let reads = 0;
    let windowStart = Date.now();

    (async () => {
      await w.ready('sensor', 5000);
      await (w.module('sensor') as any).attach(name, CAPACITY);
      if (!alive) return;

      // The host opens the same block. From here on the producer and this
      // reader touch one piece of memory with no messages between them.
      const buf = new SharedBuffer(name, (HEADER + CAPACITY) * 4);
      bufRef.current = buf;
      viewRef.current = new Float32Array(buf.arrayBuffer);

      await (w.module('sensor') as any).start(hz);
      if (!alive) return;
      setRunning(true);

      loop = setInterval(() => {
        const v = viewRef.current;
        if (!v) return;

        // Take the same lock the producer uses, so the cursor and the samples
        // we copy out are consistent with each other. The critical section is
        // deliberately tiny — copy, then do the maths outside it.
        const snapshot = new Float32Array(BARS);
        let cursor = 0;
        buf.withLock(() => {
          cursor = v[0]!;
          // Most recent BARS samples, oldest first.
          for (let i = 0; i < BARS; i++) {
            const idx = cursor - BARS + i;
            snapshot[i] = idx < 0 ? 0 : v[HEADER + (idx % CAPACITY)]!;
          }
        });

        setBars(Array.from(snapshot));
        setProduced(cursor);
        setProducerHz(v[1]!);

        reads++;
        const elapsed = Date.now() - windowStart;
        if (elapsed >= 500) {
          setReadsPerSec(Math.round((reads * 1000) / elapsed));
          reads = 0;
          windowStart = Date.now();
        }
      }, 33);
    })();

    return () => {
      alive = false;
      if (loop) clearInterval(loop);
      const n = nameRef.current;
      if (n) (w.module('sensor') as any)?.dispose?.(n);
      w.terminate();
    };
    // `hz` is read once, as the rate the worker STARTS at. Later changes go
    // through `changeRate`, which calls into the running worker. Adding it to
    // the deps would tear down and rebuild the worker on every rate change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRate = async (next: number) => {
    setHz(next);
    await (workerRef.current?.module('sensor') as any)?.start(next);
    setRunning(true);
  };

  const toggle = async () => {
    const m: any = workerRef.current?.module('sensor');
    if (!m) return;
    if (running) {
      await m.stop();
      setRunning(false);
    } else {
      await m.start(hz);
      setRunning(true);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        A worker samples a signal into a ring buffer in shared memory. This
        screen draws whatever is in the ring when it repaints — the producer and
        the reader run at completely independent rates.
      </Text>

      <View style={styles.scope}>
        {bars.map((v, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: Math.max(2, Math.min(1, Math.abs(v)) * 60),
                backgroundColor: v >= 0 ? '#1565c0' : '#b3261e',
                marginTop: v >= 0 ? 60 - Math.min(1, Math.abs(v)) * 60 : 60,
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.stats}>
        <Stat label="samples produced" value={produced.toLocaleString()} />
        <Stat label="producer" value={`${Math.round(producerHz)} Hz`} />
        <Stat label="this screen reads" value={`${readsPerSec} Hz`} />
      </View>

      <Text style={styles.dim}>
        The producer is running far ahead of the UI. Nothing queues up and
        nothing is dropped in transit — old samples are simply overwritten in
        the ring, which is what a real sensor pipeline wants.
      </Text>

      <Text style={styles.section}>Sample rate</Text>
      <View style={styles.row}>
        {RATES.map((r) => (
          <Pressable
            key={r}
            style={[styles.chip, hz === r && styles.chipOn]}
            onPress={() => changeRate(r)}
          >
            <Text style={[styles.chipText, hz === r && styles.chipTextOn]}>
              {r} Hz
            </Text>
          </Pressable>
        ))}
        <Pressable style={[styles.chip, styles.chipAlt]} onPress={toggle}>
          <Text style={styles.chipTextOn}>{running ? 'Stop' : 'Start'}</Text>
        </Pressable>
      </View>

      <Text style={styles.dim}>
        Both sides take the buffer's lock with `withLock`. The producer writes a
        burst and its cursor together; the reader copies out the window it
        wants. Without that, a repaint could catch half of a burst and draw a
        torn waveform.
      </Text>
    </View>
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

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 12 },
  scope: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    height: 120,
    backgroundColor: '#f7f8fa',
    borderRadius: 8,
    paddingHorizontal: 4,
    gap: 1,
  },
  bar: { flex: 1, borderRadius: 1 },
  stats: { flexDirection: 'row', gap: 10, marginTop: 12 },
  stat: {
    flex: 1,
    backgroundColor: '#f2f4f7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  statValue: { fontSize: 16, fontWeight: '700' },
  statLabel: { fontSize: 10, color: '#777', marginTop: 2, textAlign: 'center' },
  section: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: '#1565c0',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  chipOn: { backgroundColor: '#1565c0' },
  chipAlt: { backgroundColor: '#5c6bc0', borderColor: '#5c6bc0' },
  chipText: { color: '#1565c0', fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: 'white', fontWeight: '600', fontSize: 13 },
  dim: { fontSize: 12, color: '#777', lineHeight: 18, marginTop: 10 },
});
