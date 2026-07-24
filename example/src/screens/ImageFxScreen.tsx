import { useEffect, useRef, useState } from 'react';
import {
  Text,
  View,
  Image,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Worker, SharedBuffer } from '@ammarahmed/react-native-workers';

const W = 192;
const H = 192;
const FILTERS = ['grayscale', 'invert', 'sepia', 'blur', 'pixelate'];

export default function ImageFxScreen() {
  const workerRef = useRef<Worker | null>(null);
  const namesRef = useRef<{ src: string; dst: string } | null>(null);
  const bufRef = useRef<SharedBuffer | null>(null);

  const [original, setOriginal] = useState<string | null>(null);
  const [filtered, setFiltered] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [stall, setStall] = useState(0);
  const [bytes, setBytes] = useState(0);

  // A heartbeat on the JS thread. The gap between ticks is the honest measure
  // of whether the UI thread was blocked — a spinner can lie, this cannot.
  const lastTick = useRef(0);
  const worstGap = useRef(0);
  useEffect(() => {
    lastTick.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick.current;
      lastTick.current = now;
      if (gap > worstGap.current) worstGap.current = gap;
    }, 16);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const ns = 'fx-' + Date.now().toString(36);
    const names = { src: ns + ':src', dst: ns + ':dst' };
    namesRef.current = names;

    const w = new Worker('../workers/imagefx');
    workerRef.current = w;

    let alive = true;
    (async () => {
      await w.ready('imagefx', 5000);
      // The HOST allocates the pixel memory. The worker opens the same names and
      // gets a view over these exact bytes — nothing is copied either way.
      bufRef.current = new SharedBuffer(names.src, W * H * 4);
      new SharedBuffer(names.dst, W * H * 4);

      const res: any = await (w.module('imagefx') as any).init(
        names.src,
        names.dst,
        W,
        H
      );
      if (!alive) return;
      setBytes(res.bytes);
      setOriginal(res.png);

      // Run the heaviest filter once on arrival, so the screen shows the
      // comparison immediately instead of an empty box.
      worstGap.current = 0;
      const first: any = await (w.module('imagefx') as any).apply('blur');
      if (!alive) return;
      setFiltered(first.png);
      setStall(worstGap.current);
      setInfo(
        `blur in the worker — filter ${first.filterMs}ms, encode ${first.encodeMs}ms`
      );
    })();

    return () => {
      alive = false;
      const n = namesRef.current;
      if (n) (w.module('imagefx') as any)?.release?.(n.src, n.dst);
      w.terminate();
    };
  }, []);

  const runInWorker = async (filter: string) => {
    const w = workerRef.current;
    if (!w) return;
    setBusy(true);
    worstGap.current = 0;
    const res: any = await (w.module('imagefx') as any).apply(filter);
    setFiltered(res.png);
    setStall(worstGap.current);
    setInfo(
      `${filter} in the worker — filter ${res.filterMs}ms, encode ${res.encodeMs}ms`
    );
    setBusy(false);
  };

  // The same work, deliberately on the JS thread, to show what it costs. Reads
  // the shared pixels directly — the buffer is as accessible from here as it is
  // from the worker.
  const runOnJsThread = () => {
    const buf = bufRef.current;
    if (!buf) return;
    worstGap.current = 0;
    const src = new Uint8Array(buf.arrayBuffer);
    const out = new Uint8Array(src.length);
    const t0 = Date.now();
    // A box blur, same shape as the worker's heaviest filter.
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            let n = 0;
            for (let k = -4; k <= 4; k++) {
              const xx = x + k;
              if (xx < 0 || xx >= W) continue;
              sum += src[(y * W + xx) * 4 + c]!;
              n++;
            }
            out[i + c] = (sum / n) | 0;
          }
          out[i + 3] = 255;
        }
      }
    }
    const ms = Date.now() - t0;
    setInfo(`blur on the JS thread — ${ms}ms, and the UI could not run`);
    // Read on the next tick so the heartbeat has recorded the stall.
    setTimeout(() => setStall(worstGap.current), 50);
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.intro}>
        {(bytes / 1024).toFixed(0)}KB of RGBA pixels live in one SharedBuffer.
        The worker filters them in place — the pixels never cross between
        runtimes, only the finished PNG does.
      </Text>

      <View style={styles.imgRow}>
        <View style={styles.imgBox}>
          <Text style={styles.imgLabel}>source</Text>
          {original ? (
            <Image
              style={styles.img}
              source={{ uri: 'data:image/png;base64,' + original }}
            />
          ) : (
            <View style={[styles.img, styles.imgEmpty]}>
              <ActivityIndicator />
            </View>
          )}
        </View>
        <View style={styles.imgBox}>
          <Text style={styles.imgLabel}>filtered</Text>
          {filtered ? (
            <Image
              style={styles.img}
              source={{ uri: 'data:image/png;base64,' + filtered }}
            />
          ) : (
            <View style={[styles.img, styles.imgEmpty]}>
              <Text style={styles.dim}>pick a filter</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            style={[styles.chip, busy && styles.chipOff]}
            disabled={busy}
            onPress={() => runInWorker(f)}
          >
            <Text style={styles.chipText}>{f}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.info}>{info || 'nothing run yet'}</Text>
      <Text style={styles.dim}>
        worst UI frame gap during that run: {stall}ms
      </Text>

      <Pressable style={styles.danger} onPress={runOnJsThread}>
        <Text style={styles.chipText}>Run a blur on the JS thread instead</Text>
      </Pressable>
      <Text style={styles.dim}>
        Same pixels, same kind of work, wrong thread. (It is the cheaper half of
        the worker's blur — horizontal passes only — so compare the frame gap,
        not the durations: the worker runs leave it at roughly one frame, this
        one stalls for as long as it runs.)
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 12 },
  imgRow: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  imgBox: { alignItems: 'center' },
  imgLabel: { fontSize: 11, color: '#888', marginBottom: 4 },
  img: { width: 150, height: 150, borderRadius: 8, backgroundColor: '#eee' },
  imgEmpty: { alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  chip: {
    backgroundColor: '#1565c0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  chipOff: { opacity: 0.4 },
  chipText: { color: 'white', fontWeight: '600', fontSize: 13 },
  info: { fontSize: 13, marginTop: 14, fontWeight: '600' },
  dim: { fontSize: 12, color: '#777', lineHeight: 18, marginTop: 4 },
  danger: {
    backgroundColor: '#b3261e',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 16,
  },
});
