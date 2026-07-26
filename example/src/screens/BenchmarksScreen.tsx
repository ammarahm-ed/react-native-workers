import { useEffect, useState } from 'react';
import { Text, View, StyleSheet, ScrollView } from 'react-native';
import { runBenchmarks, type Bench } from '../bench';
import { markReady } from '../devReady';

export default function BenchmarksScreen() {
  const [benches, setBenches] = useState<Bench[]>([]);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await runBenchmarks();
        if (cancelled) return;
        setBenches(b);
        markReady('benchmarks', 'data');
        // Machine-readable summary, same shape the test screen emits.
        console.log(
          `[RNWORKERS-BENCH] ${JSON.stringify(
            b.map((x) => ({ n: x.name, d: x.detail }))
          )}`
        );
      } catch (err) {
        if (cancelled) return;
        setBenches([
          { name: 'bench-error', detail: String((err as any)?.message ?? err) },
        ]);
      }
      if (!cancelled) setRunning(false);
    })();
    // Benchmarks spin worker threads; don't touch state if the user navigated
    // away mid-run.
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.summary}>
        {running ? 'running…' : `${benches.length} benchmarks`}
      </Text>
      <ScrollView style={styles.log}>
        {benches.map((b, i) => (
          <View key={i} style={styles.benchRow}>
            <Text style={styles.name}>{b.name}</Text>
            <Text style={styles.benchDetail}>{b.detail}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  summary: { fontSize: 15, marginBottom: 10, color: '#555' },
  log: { flex: 1 },
  benchRow: { marginBottom: 8 },
  name: { fontSize: 14, fontWeight: '500' },
  benchDetail: { fontSize: 13, color: '#1565c0', fontFamily: 'Courier' },
});
