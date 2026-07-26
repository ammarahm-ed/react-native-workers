import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  TextInput,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { Worker } from '@ammarahmed/react-native-workers';
import { markReady } from '../devReady';

type Hit = { id: number; title: string; snippet: string };

// The "backend" the worker pulls from. In a real app this would be a network
// call or a database read — the point is that it lives on the HOST and the
// worker reaches back for it.
const WORDS =
  'alpha bridge cache daemon engine fabric gradle hermes index jsi kotlin lambda metro native opaque parser queue runtime shadow thread unicode vector worker xcode yield zygote'.split(
    ' '
  );
function makeDocs(n: number) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    const pick = (k: number) =>
      Array.from(
        { length: k },
        (_, j) => WORDS[(i * 7 + j * 13) % WORDS.length]
      ).join(' ');
    docs.push({ id: i, title: `Doc ${i}: ${pick(3)}`, body: pick(24) });
  }
  return docs;
}

export default function SearchServiceScreen() {
  const workerRef = useRef<Worker | null>(null);
  const [query, setQuery] = useState('worker');
  const [hits, setHits] = useState<Hit[]>([]);
  const [timing, setTiming] = useState<string>('');
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [building, setBuilding] = useState(true);

  const logEvent = (s: string) => setEvents((e) => [s, ...e].slice(0, 8));

  useEffect(() => {
    const w = new Worker('../workers/search');
    workerRef.current = w;

    // host -> worker direction: a module the WORKER can call. This is what makes
    // the bridge two-way rather than request/response.
    w.registerModule('app', {
      fetchDocs() {
        logEvent('worker → host: fetchDocs()');
        return makeDocs(2000);
      },
      log(message: string) {
        logEvent(`worker → host: ${message}`);
      },
    });

    const search: any = w.module('search');
    // Worker-emitted events, streamed while it indexes.
    search.$on('progress', (p: any) => setProgress(p));

    (async () => {
      try {
        await w.ready('search', 5000);
        const built = await search.build();
        setStats(built);
        setBuilding(false);
        logEvent(`indexed ${built.docs} docs / ${built.terms} terms`);
        await runSearch('worker');
        markReady('search', 'data');
      } catch (err: any) {
        logEvent(`error: ${err?.message ?? err}`);
        setBuilding(false);
      }
    })();

    return () => w.terminate();
  }, []);

  const runSearch = async (q: string) => {
    const w = workerRef.current;
    if (!w) return;
    const res: any = await (w.module('search') as any).search(q);
    setHits(res.hits);
    setTiming(
      `${res.hits.length} shown / ${res.scanned} matched in ${res.ms}ms`
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        The worker owns the corpus and the inverted index. The host sends a
        query and gets typed results as a promise; the worker calls back into a
        host module for its data and streams progress events while indexing.
      </Text>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            runSearch(t);
          }}
          placeholder="search…"
          autoCapitalize="none"
          editable={!building}
        />
        <Pressable style={styles.btn} onPress={() => runSearch(query)}>
          <Text style={styles.btnText}>Search</Text>
        </Pressable>
      </View>

      {building ? (
        <View style={styles.building}>
          <ActivityIndicator />
          <Text style={styles.dim}>
            {progress
              ? `indexing ${progress.done}/${progress.total}`
              : 'starting worker…'}
          </Text>
        </View>
      ) : (
        <Text style={styles.dim}>
          {timing}
          {stats
            ? `  ·  index: ${stats.terms} terms, built in ${stats.ms}ms`
            : ''}
        </Text>
      )}

      <ScrollView style={styles.results}>
        {hits.map((h) => (
          <View key={h.id} style={styles.hit}>
            <Text style={styles.hitTitle}>{h.title}</Text>
            <Text style={styles.hitBody}>{h.snippet}…</Text>
          </View>
        ))}
        {!building && hits.length === 0 && (
          <Text style={styles.dim}>no matches</Text>
        )}
      </ScrollView>

      <Text style={styles.section}>Bridge traffic</Text>
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
  searchRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 8,
  },
  btnText: { color: 'white', fontWeight: '600', fontSize: 13 },
  building: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  dim: { fontSize: 12, color: '#777' },
  results: { flex: 1, marginTop: 8 },
  hit: { marginBottom: 8 },
  hitTitle: { fontSize: 14, fontWeight: '600' },
  hitBody: { fontSize: 12, color: '#666', fontFamily: 'Courier' },
  section: { fontSize: 13, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  event: {
    fontSize: 11,
    color: '#2e7d32',
    fontFamily: 'Courier',
    marginBottom: 2,
  },
});
