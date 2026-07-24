import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Text,
  View,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from 'react-native';
import { UIWorker } from '@ammarahmed/react-native-workers';
import {
  createWorkerComponent,
  type Descriptor,
} from '../native-components/createWorkerComponent';

type Line = { text: string; kind: 'ok' | 'err' | 'info' };

// A few places on the map to jump between, to show props driving MapKit.
const PLACES = [
  {
    name: 'San Francisco',
    lat: 37.7749,
    lng: -122.4194,
    radius: 12,
    pins: [
      { id: 'ggb', lat: 37.8199, lng: -122.4783, title: 'Golden Gate Bridge' },
      { id: 'ferry', lat: 37.7955, lng: -122.3937, title: 'Ferry Building' },
    ],
  },
  {
    name: 'New York',
    lat: 40.7484,
    lng: -73.9857,
    radius: 8,
    pins: [
      { id: 'esb', lat: 40.7484, lng: -73.9857, title: 'Empire State' },
      { id: 'cp', lat: 40.7829, lng: -73.9654, title: 'Central Park' },
    ],
  },
  {
    name: 'Tokyo',
    lat: 35.6586,
    lng: 139.7454,
    radius: 10,
    pins: [{ id: 'tower', lat: 35.6586, lng: 139.7454, title: 'Tokyo Tower' }],
  },
];

export default function NativeComponentScreen() {
  const [lines, setLines] = useState<Line[]>([]);
  // Resolved once the shared worker library is up. It is a process singleton, so
  // navigating away and back reuses it instead of re-registering view managers.
  const [components, setComponents] = useState<Record<
    string,
    ComponentType<any>
  > | null>(null);

  const [switchOn, setSwitchOn] = useState(false);
  const [tone, setTone] = useState<'blue' | 'green' | 'pink'>('blue');
  const [place, setPlace] = useState(0);
  const [mapType, setMapType] = useState<'standard' | 'satellite' | 'hybrid'>(
    'standard'
  );

  const log = (text: string, kind: Line['kind'] = 'ok') =>
    setLines((l) => [{ text, kind }, ...l].slice(0, 40));
  const logRef = useRef(log);
  logRef.current = log;

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    // The natural per-screen pattern: create a handle on mount, terminate it on
    // unmount. It works across navigation because UIWorker runtimes are now
    // shared + persistent by default — the FIRST visit evaluates the worker and
    // registers the view managers; every later visit reconnects to the same
    // runtime (no reload, no re-register), and terminate() only disconnects the
    // handle. No app-side singleton needed.
    const w = new UIWorker('../workers/nativecomponents', {
      nativeModules: true,
    });
    w.onerror = (e: any) => logRef.current(`worker error: ${e.message}`, 'err');

    (async () => {
      try {
        await w.ready('nativecomponents', 8000);
        // One-time query for the component descriptors. Props flow natively;
        // events come back over the worker's RPC channel (routed by React tag).
        const descriptors: Descriptor[] = await (
          w.module('nativecomponents') as any
        ).list();
        if (!alive) return;
        const resolved: Record<string, ComponentType<any>> = {};
        for (const d of descriptors)
          resolved[d.name] = createWorkerComponent(d);
        setComponents(resolved);
        logRef.current(
          `components: ${descriptors.map((d) => d.name).join(', ')}`,
          'info'
        );
      } catch (err: any) {
        logRef.current(`load failed: ${err?.message ?? err}`, 'err');
      }
    })();

    return () => {
      alive = false;
      w.terminate();
    };
  }, []);

  if (Platform.OS !== 'ios') {
    return (
      <View style={styles.container}>
        <Text style={styles.intro}>
          This example builds Obj-C classes at runtime through NativeScript's
          interop, which is iOS-only.
        </Text>
      </View>
    );
  }

  const WorkerBadge = components?.WorkerBadge;
  const WorkerSwitch = components?.WorkerSwitch;
  const WorkerMap = components?.WorkerMap;
  const current = PLACES[place]!;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Real React Native host components whose view managers were written in
        JavaScript and registered from inside the UIWorker at runtime. No native
        code, no codegen, no podspec.
      </Text>

      <Text style={styles.section}>WorkerMap — a live MKMapView</Text>
      {WorkerMap ? (
        <WorkerMap
          style={styles.map}
          lat={current.lat}
          lng={current.lng}
          radius={current.radius}
          mapType={mapType}
          pins={current.pins}
          onSelectPin={(e: any) => log(`tapped pin: ${e.nativeEvent.title}`)}
          onRegionChange={(e: any) => {
            const r = e.nativeEvent;
            log(
              `region → ${r.lat.toFixed(3)}, ${r.lng.toFixed(3)} (Δ ${r.latitudeDelta.toFixed(2)})`
            );
          }}
        />
      ) : (
        <View style={[styles.map, styles.center]}>
          <Text style={styles.stageHint}>loading map…</Text>
        </View>
      )}
      <View style={styles.row}>
        {PLACES.map((p, i) => (
          <Chip
            key={p.name}
            label={p.name}
            active={i === place}
            onPress={() => setPlace(i)}
          />
        ))}
      </View>
      <View style={styles.row}>
        {(['standard', 'satellite', 'hybrid'] as const).map((t) => (
          <Chip
            key={t}
            label={t}
            active={t === mapType}
            onPress={() => setMapType(t)}
          />
        ))}
      </View>
      <Text style={styles.note}>
        A full MKMapViewDelegate — custom MKMarkerAnnotationViews, pin-selection
        and region-change callbacks — plus struct-based camera control, all in
        JS. Props move the camera and the pins; the map's own events come back
        to React state.
      </Text>

      <Text style={styles.section}>WorkerBadge</Text>
      <View style={styles.stage}>
        {WorkerBadge ? (
          <WorkerBadge
            title={`tone: ${tone}`}
            tone={tone}
            style={styles.badge}
          />
        ) : (
          <Text style={styles.stageHint}>waiting…</Text>
        )}
      </View>
      <Text
        style={styles.link}
        onPress={() =>
          setTone((t) =>
            t === 'blue' ? 'green' : t === 'green' ? 'pink' : 'blue'
          )
        }
      >
        change tone prop →
      </Text>

      <Text style={styles.section}>WorkerSwitch</Text>
      <View style={styles.row}>
        {WorkerSwitch ? (
          <WorkerSwitch
            value={switchOn}
            tint
            style={styles.switch}
            onValueChange={(e: any) => {
              const next = e.nativeEvent.value;
              setSwitchOn(next);
              log(`onValueChange → ${next}`);
            }}
          />
        ) : (
          <Text style={styles.stageHint}>waiting…</Text>
        )}
        <Text style={styles.state}>value = {String(switchOn)}</Text>
      </View>

      <View style={styles.log}>
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
      </View>
    </ScrollView>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  content: { paddingBottom: 32 },
  intro: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  map: { height: 260, borderRadius: 14, overflow: 'hidden' },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f4f7',
  },
  stage: {
    height: 90,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f4f7',
    borderRadius: 14,
  },
  stageHint: { fontSize: 11, color: '#9aa0a6' },
  badge: { width: 180, height: 44 },
  switch: { width: 51, height: 31 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  state: { fontSize: 13, fontFamily: 'Courier', color: '#333' },
  link: { fontSize: 12, color: '#1565c0', marginTop: 6 },
  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#eceff1',
  },
  chipActive: { backgroundColor: '#1565c0' },
  chipPressed: { opacity: 0.7 },
  chipText: { fontSize: 12, color: '#333' },
  chipTextActive: { color: 'white', fontWeight: '600' },
  log: { marginTop: 14 },
  line: {
    fontSize: 11,
    fontFamily: 'Courier',
    color: '#2e7d32',
    marginBottom: 3,
  },
  err: { color: '#c62828' },
  info: { color: '#333', fontWeight: '700' },
});
