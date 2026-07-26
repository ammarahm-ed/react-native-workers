import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Worker } from '@ammarahmed/react-native-workers';

type ProbeResult = {
  workerAlive: boolean;
  rnTurboModule: { resolved: boolean; reachable: boolean };
  expoModules: {
    installed: boolean;
    how: string;
    keys?: string[];
    constant?: string;
    asyncCall?: string;
    syncCall?: string;
    property?: string;
    event?: string;
  };
};

type Row = { label: string; ok: boolean | null; detail?: string };

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const out: Row[] = [];

    // Host-side sanity: an Expo module works on the MAIN runtime.
    out.push({
      label: 'Host: expo-constants (main runtime)',
      ok: !!Constants.expoConfig || !!Constants.systemFonts,
      detail: `appOwnership=${String(Constants.appOwnership)}`,
    });

    // `nativeModules: true` builds the per-worker TurboModule manager AND (on
    // Expo apps) installs the Expo Modules API into this worker runtime.
    const w = new Worker('./src/workers/probe', { nativeModules: true });
    const timer = setTimeout(() => {
      out.push({ label: 'Worker: probe', ok: false, detail: 'timed out' });
      setRows([...out]);
      w.terminate();
    }, 8000);

    w.onmessage = (e: any) => {
      clearTimeout(timer);
      const r = e.data as ProbeResult;
      console.log('[expo-example] probe result:', JSON.stringify(r, null, 2));
      out.push({ label: 'Worker: alive (roundtrip)', ok: !!r.workerAlive });
      out.push({
        label: 'Worker: RN/Cxx TurboModule reachable',
        ok: r.rnTurboModule.resolved && r.rnTurboModule.reachable,
        detail: `resolved=${r.rnTurboModule.resolved} createWorker=${r.rnTurboModule.reachable}`,
      });
      out.push({
        label: 'Worker: Expo Modules API installed',
        ok: r.expoModules.installed,
        detail:
          r.expoModules.how +
          (r.expoModules.keys ? ` [${r.expoModules.keys.join(', ')}]` : ''),
      });
      out.push({
        label: 'Worker: Expo constant (sync read)',
        ok: !!r.expoModules.constant && !/threw/.test(r.expoModules.constant),
        detail: r.expoModules.constant,
      });
      out.push({
        label: 'Worker: Expo async function (Promise)',
        ok:
          !!r.expoModules.asyncCall &&
          !/threw|WRONG/.test(r.expoModules.asyncCall),
        detail: r.expoModules.asyncCall,
      });
      out.push({
        label: 'Worker: Expo sync function (direct value)',
        ok:
          !!r.expoModules.syncCall &&
          !/threw|WRONG/.test(r.expoModules.syncCall),
        detail: r.expoModules.syncCall,
      });
      out.push({
        label: 'Worker: Expo dynamic property (live read)',
        ok:
          !!r.expoModules.property &&
          !/threw|WRONG|absent/.test(r.expoModules.property),
        detail: r.expoModules.property,
      });
      out.push({
        label: 'Worker: Expo event (module → worker)',
        ok:
          !!r.expoModules.event &&
          !/threw|WRONG|absent|timed out/.test(r.expoModules.event),
        detail: r.expoModules.event,
      });
      setRows([...out]);
      w.terminate();
    };
    w.onerror = (e: any) => {
      clearTimeout(timer);
      out.push({ label: 'Worker: probe', ok: false, detail: e.message });
      setRows([...out]);
      w.terminate();
    };
    w.postMessage('probe');

    return () => {
      clearTimeout(timer);
      w.terminate();
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>react-native-workers × Expo</Text>
      <Text style={styles.sub}>
        Expo modules running directly inside a worker runtime.
      </Text>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.map((r, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.badge}>
              {r.ok == null ? '…' : r.ok ? '✅' : '❌'}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.label}>{r.label}</Text>
              {r.detail ? <Text style={styles.detail}>{r.detail}</Text> : null}
            </View>
          </View>
        ))}
        {rows.length === 0 ? <Text style={styles.detail}>Running…</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingTop: 64,
    paddingHorizontal: 20,
    backgroundColor: '#fff',
  },
  title: { fontSize: 20, fontWeight: '700' },
  sub: { fontSize: 13, color: '#666', marginTop: 4, marginBottom: 16 },
  list: { paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  badge: { fontSize: 16, width: 26 },
  rowText: { flex: 1 },
  label: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 12, color: '#888', marginTop: 2 },
});
