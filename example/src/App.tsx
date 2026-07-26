import { useCallback, useEffect, useState } from 'react';
import {
  Text,
  View,
  Image,
  StyleSheet,
  Pressable,
  BackHandler,
  Platform,
  Linking,
} from 'react-native';
import HomeScreen from './screens/HomeScreen';
import { findScreen, type ScreenId } from './screens';
import { markReady } from './devReady';

/**
 * Screen to open on launch instead of the home list. Inlined at build time by
 * the babel config in `babel.config.js` from the `RN_WORKERS_SCREEN` env var, so
 * a CI/test run can boot straight into the suite:
 *
 *   RN_WORKERS_SCREEN=tests yarn start --reset-cache
 *
 * The value is baked in when Metro transforms the bundle, so changing it needs a
 * Metro restart with a cache reset. Empty/absent means "start at home".
 */
const INITIAL_SCREEN: string | undefined =
  process.env.RN_WORKERS_SCREEN || undefined;

/**
 * Dev-only deep link, for when a Metro restart per screen is too slow (docs
 * screenshots, a quick manual check):
 *
 *   xcrun simctl openurl booted rnworkers://screen/sensor
 *   adb shell am start -a android.intent.action.VIEW -d rnworkers://screen/home
 *
 * `rnworkers://screen/home` returns to the list. The scheme is declared in the
 * iOS Info.plist and the Android manifest; unlike `RN_WORKERS_SCREEN` it needs
 * no rebuild and no cache reset.
 */
const LINK_PREFIX = 'rnworkers://screen/';

function screenFromUrl(
  url: string | null | undefined
): ScreenId | null | undefined {
  if (!url || !url.startsWith(LINK_PREFIX)) return undefined; // not ours
  const id = url.slice(LINK_PREFIX.length).replace(/[/?#].*$/, '');
  if (!id || id === 'home') return null;
  return findScreen(id)?.id ?? null;
}

export default function App() {
  // `null` = home. Deep-linking to an unknown id falls back to home rather than
  // rendering nothing, so a typo in the env var is obvious instead of silent.
  const [current, setCurrent] = useState<ScreenId | null>(
    findScreen(INITIAL_SCREEN)?.id ?? null
  );

  const goHome = useCallback(() => setCurrent(null), []);

  // Android hardware back: leave a screen instead of exiting the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (current == null) return false; // let the OS close the app
      goHome();
      return true;
    });
    return () => sub.remove();
  }, [current, goHome]);

  useEffect(() => {
    if (!__DEV__) return;
    const handle = (url: string | null | undefined) => {
      const next = screenFromUrl(url);
      if (next === undefined) return;
      setCurrent(next);
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // Rendered-state marker for external tooling — see `devReady.ts`.
  useEffect(() => {
    markReady(current ?? 'home');
  }, [current]);

  const screen = findScreen(current ?? undefined);
  const Component = screen?.component;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {screen && (
          <Pressable onPress={goHome} hitSlop={12} style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
        )}
        {!screen && (
          // The docs logo, as a PNG so the example needs no react-native-svg
          // (the SVG's gear animation would not survive the conversion anyway).
          <Image
            source={require('./assets/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        )}
        <Text style={styles.title}>
          {screen?.title ?? 'react-native-workers'}
        </Text>
      </View>
      {Component ? <Component /> : <HomeScreen onOpen={setCurrent} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 60, backgroundColor: 'white' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  back: { marginRight: 12 },
  logo: { width: 30, height: 30, marginRight: 10, borderRadius: 6 },
  backText: { fontSize: 16, color: '#1565c0' },
  title: { fontSize: 18, fontWeight: '700', flexShrink: 1 },
});
