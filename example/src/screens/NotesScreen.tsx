import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  TextInput,
  StyleSheet,
  Pressable,
  Switch,
} from 'react-native';
import { Worker, SharedStore } from '@ammarahmed/react-native-workers';
import { markReady } from '../devReady';

const SAMPLE =
  'React Native workers run real Hermes runtimes on their own threads. ' +
  'Type here and the word count is computed in a worker, not on this thread.';

const BURST = ' Shared state means no message per keystroke.';

export default function NotesScreen() {
  const workerRef = useRef<Worker | null>(null);
  const storeRef = useRef<SharedStore | null>(null);
  const nameRef = useRef<string | null>(null);

  const [text, setText] = useState('');
  const [live, setLive] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const [saves, setSaves] = useState(0);
  const [notifications, setNotifications] = useState(0);
  const [keystrokes, setKeystrokes] = useState(0);
  const [batched, setBatched] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A store name unique to this mount. Stores are process-wide and survive a
    // JS reload, so a fixed name inherits whatever the last run left behind —
    // including subscribers from workers that are no longer around.
    const name = 'notes-' + Date.now().toString(36);
    nameRef.current = name;

    const w = new Worker('../workers/notes');
    workerRef.current = w;

    w.registerModule('app', {
      onSaved(n: number) {
        setSaves(n);
      },
    });

    let alive = true;
    (async () => {
      await w.ready('notes', 5000);
      // ORDER MATTERS. The worker has to be subscribed before anything writes:
      // a store write with no watcher is simply not observed, and nothing
      // replays it later. Awaiting attach() is what guarantees that.
      await (w.module('notes') as any).attach(name);
      if (!alive) return;

      const store = new SharedStore(name);
      storeRef.current = store;

      // The host watches the same store the worker writes to.
      store.subscribe('stats', (_k, value: any) => {
        setNotifications((n) => n + 1);
        if (value?.live) setLive(value.live);
        if (value?.saved) setSaved(value.saved);
      });

      setReady(true);
      typeOut(SAMPLE);
      markReady('notes', 'data');
    })();

    return () => {
      alive = false;
      const n = nameRef.current;
      if (n) (w.module('notes') as any)?.dispose?.(n);
      w.terminate();
    };
  }, []);

  /** Feeds characters in a few at a time, so the debounce and the live counters
   *  behave the way they would under real typing. */
  const typeOut = (source: string) => {
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(source.length, i + 4);
      const next = source.slice(0, i);
      setText(next);
      storeRef.current?.setIn('doc', ['text'], next);
      setKeystrokes((k) => k + 1);
      if (i >= source.length) clearInterval(id);
    }, 40);
  };

  // Every keystroke is a synchronous shared-store write — no message, no bridge
  // round trip. The worker sees it because it subscribed to this exact path.
  const onChange = (t: string) => {
    setText(t);
    setKeystrokes((k) => k + 1);
    storeRef.current?.setIn('doc', ['text'], t);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        The editor and the worker never exchange a message about the document.
        Both are attached to one SharedStore: keystrokes go in at `doc.text`,
        the worker computes stats and writes them back at `stats`.
      </Text>

      <TextInput
        style={styles.editor}
        value={text}
        onChangeText={onChange}
        multiline
        editable={ready}
        placeholder={ready ? 'start typing…' : 'starting worker…'}
      />

      <View style={styles.grid}>
        <Stat label="words" value={live?.words} />
        <Stat label="chars" value={live?.chars} />
        <Stat label="unique" value={live?.unique} />
        <Stat label="read" value={live ? `${live.readingSec}s` : undefined} />
      </View>

      <Text style={styles.section}>Debounced autosave</Text>
      <Text style={styles.dim}>
        saves: {saves} · last saved at {saved?.words ?? 0} words
      </Text>

      <View style={styles.switchRow}>
        <Switch
          value={batched}
          onValueChange={async (v) => {
            setBatched(v);
            await (workerRef.current?.module('notes') as any)?.setBatched(v);
          }}
        />
        <Text style={[styles.dim, styles.switchLabel]}>
          save with batch() — three fields, {batched ? 'one' : 'three'}{' '}
          notification{batched ? '' : 's'} per save
        </Text>
      </View>

      <Text style={styles.dim}>
        writes sent: {keystrokes} · notifications received: {notifications}
      </Text>
      <Text style={styles.dim}>
        Each write produces one live update; each save adds{' '}
        {batched ? '1' : '3'} more. Toggle batch() off and keep typing to watch
        the second number pull ahead.
      </Text>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => typeOut(text + BURST)}>
          <Text style={styles.btnText}>Type some more</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt]}
          onPress={async () => {
            await (workerRef.current?.module('notes') as any)?.reset();
            setText('');
            setLive(null);
            setSaved(null);
            setSaves(0);
          }}
        >
          <Text style={styles.btnText}>Reset from worker</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value?: any }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value ?? '—'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 10 },
  editor: {
    height: 130,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  grid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  stat: {
    flex: 1,
    backgroundColor: '#f2f4f7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  statValue: { fontSize: 18, fontWeight: '700' },
  statLabel: { fontSize: 11, color: '#777', marginTop: 2 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 4 },
  dim: { fontSize: 12, color: '#777', lineHeight: 18 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 8,
  },
  switchLabel: { flex: 1 },
  row: { flexDirection: 'row', gap: 8, marginTop: 14 },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  btnAlt: { backgroundColor: '#5c6bc0' },
  btnText: { color: 'white', fontWeight: '600', fontSize: 13 },
});
