import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
  findNodeHandle,
} from 'react-native';
import { UIWorker, SharedValue } from '@ammarahmed/react-native-workers';
import { markReady } from '../devReady';

// Shared cells the worker's animation loop reads/writes. Names are constants so
// both runtimes open the same cells.
const RUNNING = 'nativescript:running';
const FRAMES = 'nativescript:running:frames';

type Line = { text: string; kind: 'ok' | 'err' | 'info' };

export default function NativeScriptScreen() {
  const workerRef = useRef<UIWorker | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ready, setReady] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const stageRef = useRef<any>(null);
  // Runtime-lifecycle controls. `independent` opts out of the shared persistent
  // runtime; `reloadKey` forces the effect to build a fresh handle after a
  // terminateRuntime(). Both are safe here because this worker registers no RN
  // components — it only drives UIKit imperatively.
  const [independent, setIndependent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const log = (text: string, kind: Line['kind'] = 'ok') =>
    setLines((l) => [{ text, kind }, ...l].slice(0, 40));
  const logRef = useRef(log);
  logRef.current = log;

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    // A UIWorker: a Hermes runtime driven on the platform main thread. That is
    // the only reason the worker can talk to UIKit synchronously. Shared +
    // persistent by default; `independent` gives this handle a private runtime.
    const w = new UIWorker('../workers/nativescript', {
      nativeModules: true,
      independent,
    });
    workerRef.current = w;
    setReady(false);
    w.onerror = (e: any) =>
      logRef.current(
        `worker error: ${e.message}${e.stack ? ' | ' + e.stack : ''}`,
        'err'
      );

    logRef.current(
      independent ? 'handle → private runtime' : 'handle → shared runtime',
      'info'
    );

    (async () => {
      try {
        await w.ready('nativescript', 8000);
        const info = await (w.module('nativescript') as any).info();
        logRef.current(
          `interop installed=${info.installed} onMain=${info.onMain} backend=${info.backend}`,
          'info'
        );
        logRef.current(
          `${info.model} · ${info.system} · @${info.scale}x`,
          'info'
        );
        logRef.current(
          `${info.classes} Obj-C classes reachable from this runtime`,
          'info'
        );
        setReady(true);
        markReady('nativescript', 'data');
      } catch (err: any) {
        logRef.current(`startup failed: ${err?.message ?? err}`, 'err');
      }
    })();

    return () => {
      new SharedValue(RUNNING, 0).value = 0;
      w.terminate();
    };
  }, [independent, reloadKey]);

  // Reap the backing runtime (all handles), then rebuild a fresh one so the
  // effect visibly re-inits (device info + class count reload). On a shared
  // runtime this proves the kill switch; on an independent one it is just this
  // handle's runtime.
  const terminateRuntime = () => {
    new SharedValue(RUNNING, 0).value = 0;
    setAnimating(false);
    setFps(null);
    workerRef.current?.terminateRuntime();
    log(
      'terminateRuntime() → backing runtime reaped; rebuilding fresh…',
      'info'
    );
    setReady(false);
    setReloadKey((k) => k + 1);
  };

  const run = async (label: string, fn: (m: any) => Promise<any>) => {
    const w = workerRef.current;
    if (!w) return;
    try {
      const result = await fn(w.module('nativescript') as any);
      log(`${label} → ${JSON.stringify(result)}`);
    } catch (err: any) {
      log(`${label} ✗ ${err?.message ?? err}`, 'err');
    }
  };

  const tag = () => {
    const t = findNodeHandle(stageRef.current);
    if (t == null) log('could not resolve a native tag for the stage', 'err');
    return t;
  };

  const attach = () => {
    const t = tag();
    if (t != null) run('attach', (m) => m.attach(t));
  };

  const detach = () => {
    const t = tag();
    if (t == null) return;
    new SharedValue(RUNNING, 0).value = 0;
    setAnimating(false);
    setFps(null);
    run('detach', (m) => m.detach(t));
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
    const t = tag();
    if (t == null) return;
    setAnimating(true);
    run('animate', (m) => m.animate(t, RUNNING));

    // Sample the worker's own frame counter to show the loop really is running
    // independently of this (React) thread.
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

  // Deliberately jam the JS thread. The UIKit animation keeps running because
  // its loop lives in the UIWorker, not here.
  const blockJsThread = () => {
    const until = Date.now() + 2000;

    while (Date.now() < until) {}
    log('JS thread blocked for 2000ms', 'info');
  };

  if (Platform.OS !== 'ios') {
    return (
      <View style={styles.container}>
        <Text style={styles.intro}>
          NativeScript's Native API interop is iOS-only (napi-ios), so this
          example does not run on Android. The UIWorker itself works on both.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        <Text style={styles.mono}>@nativescript/react-native</Text> exposes the
        whole iOS SDK to JS. Its interop installs into the calling runtime, so a
        UIWorker gets its own copy — and because that runtime is already on the
        main thread, every Obj-C call below is direct and synchronous. No{' '}
        <Text style={styles.mono}>runOnUI</Text>, no dispatch, no native module.
      </Text>

      <Text style={styles.section}>A UIKit view built inside the worker</Text>
      <View ref={stageRef} style={styles.stage} collapsable={false}>
        <Text style={styles.stageHint}>empty RN view — attach to fill it</Text>
      </View>
      <View style={styles.row}>
        <Btn label="Attach UIKit" disabled={!ready} onPress={attach} />
        <Btn
          label={animating ? 'Stop' : 'Animate'}
          disabled={!ready}
          onPress={toggleAnimation}
        />
        <Btn label="Block JS thread 2s" onPress={blockJsThread} />
        <Btn label="Detach" disabled={!ready} onPress={detach} />
        {fps != null && <Text style={styles.fps}>{fps} fps (worker)</Text>}
      </View>
      <Text style={styles.note}>
        The worker finds the React-rendered view by its Fabric tag, then builds
        a UIView + CAGradientLayer + UILabel inside it with straight-line JS.
        The animation loop mutates those layers every 16ms from the main thread,
        so blocking the JS thread does not stall it. React knows nothing about
        this subtree — a re-render of the host view leaves it alone, but
        unmounting takes it with it.
      </Text>

      <Text style={styles.section}>Native UI, awaited from the worker</Text>
      <View style={styles.row}>
        <Btn
          label="Native alert"
          disabled={!ready}
          onPress={() =>
            run('alert', (m) =>
              m.alert(
                'Hello from a worker',
                'This UIAlertController was built, presented and awaited entirely inside the UIWorker.',
                ['Nice', 'Dismiss']
              )
            )
          }
        />
      </View>
      <Text style={styles.note}>
        The button handler is a JS closure the interop wraps in an Obj-C block,
        so UIKit calls back into the worker on tap — inline, because that
        runtime is already on the main thread. The worker returns a promise, the
        RPC layer awaits it, and the call above stays pending until you tap: one
        await, no callback plumbing across runtimes.
      </Text>

      <Text style={styles.section}>Call cost</Text>
      <View style={styles.row}>
        <Btn
          label="10k Obj-C calls"
          disabled={!ready}
          onPress={() => run('benchmark', (m) => m.benchmark(10000))}
        />
        <Btn
          label="Device info"
          disabled={!ready}
          onPress={() => run('info', (m) => m.info())}
        />
        <Btn
          label="RN classes"
          disabled={!ready}
          onPress={() => run('reactNative', (m) => m.reactNative())}
        />
      </View>

      <Text style={styles.section}>Runtime lifecycle</Text>
      <View style={styles.row}>
        <Btn
          label={independent ? 'Mode: independent' : 'Mode: shared'}
          onPress={() => setIndependent((v) => !v)}
        />
        <Btn label="Terminate runtime" onPress={terminateRuntime} />
      </View>
      <Text style={styles.note}>
        Shared (default): every visit to this screen reconnects to one
        persistent runtime — navigate away and back and it is instant, with no
        re-init. Independent: each handle gets its own runtime, re-initialised
        every visit. Terminate runtime reaps the backing runtime and rebuilds a
        fresh one (the class count + device info re-appear), the explicit kill
        switch that terminate() — a handle-only disconnect — deliberately never
        does.
      </Text>

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
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 8 },
  mono: { fontFamily: 'Courier', fontSize: 12, color: '#333' },
  stage: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f4f7',
    borderRadius: 14,
    marginBottom: 8,
    // The worker's UIKit subtree is a real subview of this one, so React's own
    // clipping applies to it — the rotating card stays inside the stage.
    overflow: 'hidden',
  },
  stageHint: { fontSize: 11, color: '#9aa0a6' },
  fps: {
    alignSelf: 'center',
    fontSize: 12,
    color: '#555',
    fontFamily: 'Courier',
  },
  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 2 },
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
