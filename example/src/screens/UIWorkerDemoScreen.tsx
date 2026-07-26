import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  ScrollView,
  Pressable,
  findNodeHandle,
} from 'react-native';
import {
  Worker,
  UIWorker,
  SharedValue,
} from '@ammarahmed/react-native-workers';
import { markReady } from '../devReady';

// Shared cells the worker's animation loop reads/writes. Names are constants so
// both runtimes open the same cells.
const RUNNING = 'uidemo:running';
const FRAMES = 'uidemo:running:frames';

type Line = { text: string; kind: 'ok' | 'err' | 'info' };

export default function UIWorkerDemoScreen() {
  const uiRef = useRef<UIWorker | null>(null);
  const bgRef = useRef<Worker | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ready, setReady] = useState(false);
  const [statusHidden, setStatusHidden] = useState(false);
  const boxRef = useRef<any>(null);
  const [animating, setAnimating] = useState(false);
  const [fps, setFps] = useState<number | null>(null);

  const log = (text: string, kind: Line['kind'] = 'ok') =>
    setLines((l) => [{ text, kind }, ...l].slice(0, 40));

  useEffect(() => {
    // Same worker file, two runtimes: one pinned to the main thread, one on its
    // own background thread. Everything below contrasts the two.
    const ui = new UIWorker('../workers/uidemo', { nativeModules: true });
    const bg = new Worker('../workers/uidemo', { nativeModules: true });
    uiRef.current = ui;
    bgRef.current = bg;
    // Surface worker-side failures: without this a worker that throws while
    // loading just looks like "module never became ready".
    ui.onerror = (e: any) =>
      log(
        `UIWorker error: ${e.message}${e.stack ? ' | ' + e.stack : ''}`,
        'err'
      );
    bg.onerror = (e: any) => log(`Worker error: ${e.message}`, 'err');

    (async () => {
      try {
        await Promise.all([ui.ready('uidemo', 5000), bg.ready('uidemo', 5000)]);
        const [u, b] = (await Promise.all([
          (ui.module('uidemo') as any).info(),
          (bg.module('uidemo') as any).info(),
        ])) as any[];
        log(`UIWorker  → onMain=${u.onMain}  thread=${u.thread}`, 'info');
        log(`Worker    → onMain=${b.onMain}  thread=${b.thread}`, 'info');
        setReady(true);
        markReady('uiworker', 'data');
      } catch (err: any) {
        log(`startup failed: ${err?.message ?? err}`, 'err');
      }
    })();

    return () => {
      ui.terminate();
      bg.terminate();
    };
  }, []);

  // Runs `fn` against whichever worker was asked for, logging the outcome. The
  // background path is expected to throw — that IS the demonstration.
  const run = async (
    which: 'ui' | 'bg',
    label: string,
    fn: (m: any) => Promise<any>
  ) => {
    const w = which === 'ui' ? uiRef.current : bgRef.current;
    if (!w) return;
    try {
      const result = await fn(w.module('uidemo') as any);
      log(
        `${which === 'ui' ? 'UIWorker' : 'Worker'} ${label} → ${JSON.stringify(result)}`
      );
    } catch (err: any) {
      log(
        `${which === 'ui' ? 'UIWorker' : 'Worker'} ${label} ✗ ${err?.message ?? err}`,
        'err'
      );
    }
  };

  // Start/stop is a single atomic write to a shared cell — no postMessage, no
  // round trip. The worker's loop sees it on its next tick.
  const toggleAnimation = () => {
    if (animating) {
      new SharedValue(RUNNING, 0).value = 0;
      setAnimating(false);
      setFps(null);
      return;
    }
    const tag = findNodeHandle(boxRef.current);
    if (tag == null) {
      log('could not resolve a native tag for the box', 'err');
      return;
    }
    setAnimating(true);
    run('ui', 'animate', (m) => m.animate(tag, RUNNING));
    // Sample the worker's frame counter to show the loop is really running on
    // the main thread, independently of this (React) thread.
    const frames = new SharedValue(FRAMES, 0);
    const started = Date.now();
    const iv = setInterval(() => {
      if (new SharedValue(RUNNING, 0).value !== 1) {
        clearInterval(iv);
        return;
      }
      const secs = (Date.now() - started) / 1000;
      setFps(Math.round(frames.value / Math.max(secs, 0.001)));
    }, 500);
  };

  // Deliberately jam the JS thread. The box keeps animating because its loop
  // lives in the UIWorker, not here.
  const blockJsThread = () => {
    const until = Date.now() + 2000;

    while (Date.now() < until) {}
    log('JS thread blocked for 2000ms', 'info');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        Both workers run the same file. The UIWorker's runtime is on the main
        thread, so its native calls reach UIKit directly — no dispatch, no
        method queue. The background Worker is refused.
      </Text>

      <Text style={styles.section}>Animate a real view from the UIWorker</Text>
      <View style={styles.stage}>
        <View ref={boxRef} style={styles.box} />
      </View>
      <View style={styles.row}>
        <Btn
          label={animating ? 'Stop' : 'Animate'}
          disabled={!ready}
          onPress={toggleAnimation}
        />
        <Btn label="Block JS thread 2s" onPress={blockJsThread} />
        {fps != null && <Text style={styles.fps}>{fps} fps (worker)</Text>}
      </View>
      <Text style={styles.note}>
        The loop runs in the UIWorker and writes the view's transform directly —
        no Fabric commit. Blocking the JS thread does not stop it. These writes
        are invisible to React, so a re-render resets the box.
      </Text>

      <Text style={styles.section}>Direct UI calls (UIWorker)</Text>
      <View style={styles.row}>
        <Btn
          label="Alert"
          disabled={!ready}
          onPress={() =>
            run('ui', 'showAlert', (m) =>
              m.alert(
                'From a UIWorker',
                'Presented on the main thread with no dispatch.'
              )
            )
          }
        />
        <Btn
          label="Vibrate"
          disabled={!ready}
          onPress={() => run('ui', 'vibrate', (m) => m.vibrate())}
        />
        <Btn
          label={statusHidden ? 'Show status bar' : 'Hide status bar'}
          disabled={!ready}
          onPress={() => {
            const next = !statusHidden;
            setStatusHidden(next);
            run('ui', 'statusBar', (m) => m.statusBar(next));
          }}
        />
      </View>
      <View style={styles.row}>
        <Btn
          label="Read brightness"
          disabled={!ready}
          onPress={() => run('ui', 'brightness', (m) => m.brightness())}
        />
        <Btn
          label="Dim 20%"
          disabled={!ready}
          onPress={() =>
            run('ui', 'setBrightness', async (m) =>
              m.setBrightness(Math.max(0.1, (await m.brightness()) - 0.2))
            )
          }
        />
      </View>

      <Text style={styles.section}>Call cost</Text>
      <View style={styles.row}>
        <Btn
          label="10k direct calls"
          disabled={!ready}
          onPress={() => run('ui', 'benchmark', (m) => m.benchmark(10000))}
        />
      </View>

      <Text style={styles.section}>Same calls from a background Worker</Text>
      <View style={styles.row}>
        <Btn
          label="Alert (expect throw)"
          disabled={!ready}
          onPress={() => run('bg', 'showAlert', (m) => m.alert('nope', 'nope'))}
        />
        <Btn
          label="Vibrate (expect throw)"
          disabled={!ready}
          onPress={() => run('bg', 'vibrate', (m) => m.vibrate())}
        />
      </View>

      <ScrollView style={styles.log}>
        {lines.map((l, i) => (
          <Text
            key={i}
            selectable
            style={[
              styles.line,
              l.kind === 'err' && styles.err,
              l.kind === 'info' && styles.info,
            ]}
          >
            {l.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function Btn({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        pressed && styles.btnPressed,
        disabled && styles.btnDisabled,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  stage: {
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f4f7',
    borderRadius: 10,
    marginBottom: 8,
  },
  box: { width: 56, height: 56, borderRadius: 12, backgroundColor: '#1F2229' },
  fps: {
    alignSelf: 'center',
    fontSize: 12,
    color: '#555',
    fontFamily: 'Courier',
  },
  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 2 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 10, marginBottom: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 6,
  },
  btnPressed: { opacity: 0.7 },
  btnDisabled: { backgroundColor: '#9e9e9e' },
  btnText: { color: 'white', fontSize: 13, fontWeight: '600' },
  log: { flex: 1, marginTop: 12 },
  line: {
    fontSize: 11,
    fontFamily: 'Courier',
    color: '#2e7d32',
    marginBottom: 3,
  },
  err: { color: '#c62828' },
  info: { color: '#333', fontWeight: '700' },
});
