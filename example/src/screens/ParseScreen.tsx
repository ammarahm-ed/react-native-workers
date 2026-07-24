import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { Worker } from '@ammarahmed/react-native-workers';

const LINES = 120000;
const SWEEP = [1, 2, 4, 8];

type Run = { n: number; ms: number; mbPerSec: number; slowestChildMs: number };

export default function ParseScreen() {
  const workerRef = useRef<Worker | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [corpus, setCorpus] = useState<{ used: number } | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const w = new Worker('../workers/parse');
    workerRef.current = w;

    let alive = true;
    (async () => {
      await w.ready('parse', 5000);
      const p: any = w.module('parse');
      p.$on('progress', (e: any) =>
        setProgress(`${e.finished}/${e.total} chunks done`)
      );

      setProgress('building corpus…');
      const prepared: any = await p.prepare(
        'parse-' + Date.now().toString(36),
        LINES
      );
      if (!alive) return;
      setCorpus({ used: prepared.used });

      // Sweep worker counts so the speedup is measured, not asserted.
      for (const n of SWEEP) {
        const res: any = await p.run(n);
        if (!alive) return;
        setRuns((r) => [...r, res]);
        setTotals(res.total);
      }
      setBusy(false);
      setProgress('');
    })();

    return () => {
      alive = false;
      (w.module('parse') as any)?.dispose?.();
      w.terminate();
    };
  }, []);

  const rerun = async () => {
    const p: any = workerRef.current?.module('parse');
    if (!p) return;
    setBusy(true);
    setRuns([]);
    for (const n of SWEEP) {
      const res: any = await p.run(n);
      setRuns((r) => [...r, res]);
    }
    setBusy(false);
    setProgress('');
  };

  const baseline = runs.find((r) => r.n === 1);

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        A coordinator worker owns {(LINES / 1000).toFixed(0)}k log lines in a
        SharedBuffer and spawns child workers to parse ranges of it. The text is
        never copied — children open the same memory and return only their
        tallies.
      </Text>

      <Text style={styles.section}>Time by worker count</Text>
      {runs.map((r) => {
        const best = Math.max(...runs.map((x) => x.ms));
        return (
          <View key={r.n} style={styles.barRow}>
            <Text style={styles.barLabel}>
              {r.n} {r.n === 1 ? 'worker' : 'workers'}
            </Text>
            <View style={styles.track}>
              <View
                style={[styles.fill, { width: `${(r.ms / best) * 100}%` }]}
              />
            </View>
            <Text style={styles.barValue}>{r.ms}ms</Text>
            <Text style={styles.speedup}>
              {baseline ? `${(baseline.ms / r.ms).toFixed(2)}×` : ''}
            </Text>
          </View>
        );
      })}

      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.dim}>{progress}</Text>
        </View>
      )}

      {totals && (
        <>
          <Text style={styles.section}>Result (identical for every run)</Text>
          <View style={styles.grid}>
            <Stat label="lines" value={totals.lines.toLocaleString()} />
            <Stat label="200" value={totals.ok.toLocaleString()} />
            <Stat label="404" value={totals.missing.toLocaleString()} />
            <Stat label="500" value={totals.error.toLocaleString()} />
          </View>
          <Text style={styles.dim}>
            {corpus
              ? `${(corpus.used / 1024 / 1024).toFixed(2)}MB scanned · `
              : ''}
            {runs.length > 0
              ? `${runs[runs.length - 1]!.mbPerSec.toFixed(0)}MB/s at ${
                  runs[runs.length - 1]!.n
                } workers`
              : ''}
          </Text>
        </>
      )}

      <Text style={styles.dim}>
        Chunk edges land mid-line, so each child skips the partial line it
        starts on and finishes the one it ends on — every line is counted
        exactly once, which is why the totals do not move as the worker count
        changes.
      </Text>

      <Pressable
        style={[styles.btn, busy && styles.btnOff]}
        disabled={busy}
        onPress={rerun}
      >
        <Text style={styles.btnText}>Run the sweep again</Text>
      </Pressable>
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
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  barLabel: { fontSize: 12, color: '#555', width: 72 },
  track: { flex: 1, height: 14, backgroundColor: '#eceff1', borderRadius: 7 },
  fill: { height: 14, backgroundColor: '#1565c0', borderRadius: 7 },
  barValue: {
    fontSize: 12,
    width: 56,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  speedup: {
    fontSize: 12,
    width: 46,
    textAlign: 'right',
    fontWeight: '700',
    color: '#2e7d32',
  },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  grid: { flexDirection: 'row', gap: 8 },
  stat: {
    flex: 1,
    backgroundColor: '#f2f4f7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  statValue: { fontSize: 15, fontWeight: '700' },
  statLabel: { fontSize: 10, color: '#777', marginTop: 2 },
  dim: { fontSize: 12, color: '#777', lineHeight: 18, marginTop: 8 },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 14,
  },
  btnOff: { opacity: 0.4 },
  btnText: { color: 'white', fontWeight: '600', fontSize: 13 },
});
