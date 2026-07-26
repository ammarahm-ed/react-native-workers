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
import { markReady } from '../devReady';

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
  const [cardMaterial, setCardMaterial] = useState<
    'regular' | 'thin' | 'chrome' | 'dark'
  >('regular');
  // Extra React children, to show the worker being told when they come and go.
  const [notes, setNotes] = useState<string[]>([]);

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
        markReady('nativecomponent', 'data');
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
  const WorkerCard = components?.WorkerCard;
  const current = PLACES[place]!;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Real React Native host components whose view managers were written in
        JavaScript and registered from inside the UIWorker at runtime. No native
        code, no codegen, no podspec.
      </Text>

      <Text style={styles.section}>WorkerMap — a live MKMapView</Text>
      <View>
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

        {/* A worker-defined container with ordinary React children nested inside
            it. The blur is a real UIVisualEffectView sampling the live map
            underneath; everything in the JSX below is plain RN, laid out by Yoga
            against the card's box like children of any host component. */}
        {WorkerCard && (
          <WorkerCard
            style={styles.card}
            material={cardMaterial}
            cornerRadius={18}
            onChildrenChange={(e: any) => {
              log(`card children → ${e.nativeEvent.count} views`, 'info');
            }}
          >
            <Text style={styles.cardTitle}>{current.name}</Text>
            <Text style={styles.cardBody}>
              {current.pins.length} pin{current.pins.length === 1 ? '' : 's'} ·
              backdrop blurred by UIKit
            </Text>
            {notes.map((note) => (
              <Text key={note} style={styles.cardBody}>
                • {note}
              </Text>
            ))}
            <View style={styles.cardRow}>
              <Text style={styles.cardBody}>satellite</Text>
              {/* A worker-defined component nested inside a worker-defined
                  container — and the one sharp edge. RN's interop layer mounts
                  an interop child of an interop parent by re-parenting the
                  child's own view, which loses its position, so it lands at the
                  container's origin. A `collapsable={false}` View in between
                  keeps a real RN view as the parent and it lays out normally
                  (plain `<View>` is not enough — RN would collapse it away). */}
              {WorkerSwitch && (
                <View style={styles.switch} collapsable={false}>
                  <WorkerSwitch
                    value={mapType === 'satellite'}
                    tint
                    style={styles.switch}
                    onValueChange={(e: any) =>
                      setMapType(e.nativeEvent.value ? 'satellite' : 'standard')
                    }
                  />
                </View>
              )}
            </View>
          </WorkerCard>
        )}
      </View>
      <View style={styles.row}>
        {(['regular', 'thin', 'chrome', 'dark'] as const).map((m) => (
          <Chip
            key={m}
            label={m}
            active={m === cardMaterial}
            onPress={() => setCardMaterial(m)}
          />
        ))}
        <Chip
          label={notes.length ? 'remove child' : 'add child'}
          onPress={() =>
            setNotes((n) => (n.length ? [] : ['children are real React nodes']))
          }
        />
      </View>
      <Text style={styles.note}>
        WorkerCard's host view is a UIVisualEffectView, so its React children
        have to live in the effect's{' '}
        <Text style={styles.mono}>contentView</Text>. The component says so by
        returning it from <Text style={styles.mono}>childrenView()</Text>; React
        Native's own mounting path (
        <Text style={styles.mono}>insertReactSubview:atIndex:</Text> →{' '}
        <Text style={styles.mono}>didUpdateReactSubviews</Text>) does the rest,
        and the worker gets an <Text style={styles.mono}>onChildrenChange</Text>{' '}
        event whenever React adds or removes one. The count is mounted native
        views, not JSX nodes — RN collapses layout-only Views, so the row below
        arrives as its two children.
      </Text>
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
  // No padding on the card itself: RN insets a legacy-interop component's own
  // view by the container's padding, while Yoga has already offset the children
  // by it — so padding here would inset the children twice. The children carry
  // their own margins instead.
  card: { position: 'absolute', left: 12, right: 12, bottom: 12, gap: 4 },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    marginTop: 12,
    marginHorizontal: 12,
  },
  cardBody: { fontSize: 12, color: '#333', marginHorizontal: 12 },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 12,
    marginHorizontal: 12,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  state: { fontSize: 13, fontFamily: 'Courier', color: '#333' },
  link: { fontSize: 12, color: '#1565c0', marginTop: 6 },
  note: { fontSize: 11, color: '#777', lineHeight: 16, marginTop: 8 },
  mono: { fontFamily: 'Courier', fontSize: 10, color: '#444' },
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
