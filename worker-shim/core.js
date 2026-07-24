'use strict';

/* eslint-disable @react-native/no-deep-imports -- deep imports ARE the point: this shim exists so worker bundles reach RN internals without pulling in the barrel. */

/**
 * The worker-sized stand-in for the `react-native` barrel — shared core.
 *
 * Worker bundles are their own Metro graphs, and `import … from 'react-native'`
 * drags the whole barrel into each one: the Fabric renderer, the component
 * library, Animated, virtualized-lists — ~1.37 MB of Hermes bytecode for a
 * runtime that has no views to render. You cannot avoid it by writing careful
 * worker code either, because third-party native modules import the barrel
 * themselves (`react-native-gzip` reads `NativeModules.Gzip` off it).
 *
 * So for worker graphs only, Metro resolves `react-native` to a shim built on
 * this module (see `metro/index.js`). Worker-legal exports are re-exported from
 * their real deep module; everything that only makes sense on a runtime owning
 * the UI throws a descriptive error when touched.
 *
 * Two rules govern what may be added here:
 *
 *   1. Only `require()` what is genuinely reachable from a worker. Every
 *      `require` — even inside a lazy getter — puts that module and its
 *      transitive deps into EVERY worker bundle, because Metro builds the graph
 *      statically. Lazy getters defer execution, never inclusion. This is why
 *      the heavier groups live in `react-native.js` rather than here.
 *   2. Everything else gets a throwing getter and no `require` at all, which is
 *      what keeps the renderer out of the graph.
 *
 * The getters are lazy so that a library reading `Platform.OS` at module scope
 * does not also initialise every other export.
 */

/** Unwrap `__esModule` default interop — the deep paths use it inconsistently. */
function interop(mod) {
  return mod && mod.__esModule && 'default' in mod ? mod.default : mod;
}

/**
 * Define a lazy export backed by a real React Native module. The getter
 * replaces itself with the resolved value, so repeat access is a plain read.
 */
function real(target, name, load) {
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = load();
      Object.defineProperty(target, name, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      });
      return value;
    },
  });
}

// ---------------------------------------------------------------------------
// Available in every worker bundle
// ---------------------------------------------------------------------------

real(exports, 'Platform', () =>
  interop(require('react-native/Libraries/Utilities/Platform'))
);
real(exports, 'NativeModules', () =>
  interop(require('react-native/Libraries/BatchedBridge/NativeModules'))
);
real(exports, 'TurboModuleRegistry', () =>
  require('react-native/Libraries/TurboModule/TurboModuleRegistry')
);
real(exports, 'NativeEventEmitter', () =>
  interop(require('react-native/Libraries/EventEmitter/NativeEventEmitter'))
);
real(exports, 'DeviceEventEmitter', () =>
  interop(require('react-native/Libraries/EventEmitter/RCTDeviceEventEmitter'))
);
real(exports, 'NativeAppEventEmitter', () =>
  interop(
    require('react-native/Libraries/EventEmitter/RCTNativeAppEventEmitter')
  )
);
real(exports, 'Systrace', () =>
  require('react-native/Libraries/Performance/Systrace')
);

// ---------------------------------------------------------------------------
// Not available in a worker
// ---------------------------------------------------------------------------

// Kind -> explanation. Split up so the error says something true about *why*.
const COMPONENT = 'component';
const HOST_ONLY = 'host';
const HOOK = 'hook';
/** Worker-legal, but only in the standard shim — see `react-native.js`. */
const TIER = 'tier';

const REASON = {
  [COMPONENT]:
    'is a UI component. A worker runs on its own runtime with no view tree, so ' +
    'components cannot be used there.',
  [HOST_ONLY]:
    'depends on the host runtime that owns the UI, and is not available inside ' +
    'a worker.',
  [HOOK]: 'is a React hook. A worker does not render a React tree.',
};

const UNAVAILABLE = {
  ActivityIndicator: COMPONENT,
  Button: COMPONENT,
  DrawerLayoutAndroid: COMPONENT,
  FlatList: COMPONENT,
  Image: COMPONENT,
  ImageBackground: COMPONENT,
  InputAccessoryView: COMPONENT,
  KeyboardAvoidingView: COMPONENT,
  Modal: COMPONENT,
  Pressable: COMPONENT,
  ProgressBarAndroid: COMPONENT,
  RefreshControl: COMPONENT,
  SafeAreaView: COMPONENT,
  ScrollView: COMPONENT,
  SectionList: COMPONENT,
  StatusBar: COMPONENT,
  Switch: COMPONENT,
  Text: COMPONENT,
  TextInput: COMPONENT,
  Touchable: COMPONENT,
  TouchableHighlight: COMPONENT,
  TouchableNativeFeedback: COMPONENT,
  TouchableOpacity: COMPONENT,
  TouchableWithoutFeedback: COMPONENT,
  View: COMPONENT,
  VirtualizedList: COMPONENT,
  VirtualizedSectionList: COMPONENT,

  AccessibilityInfo: HOST_ONLY,
  ActionSheetIOS: HOST_ONLY,
  Alert: HOST_ONLY,
  Animated: HOST_ONLY,
  Appearance: HOST_ONLY,
  AppRegistry: HOST_ONLY,
  BackHandler: HOST_ONLY,
  Clipboard: HOST_ONLY,
  DeviceInfo: HOST_ONLY,
  DevMenu: HOST_ONLY,
  DevSettings: HOST_ONLY,
  Dimensions: HOST_ONLY,
  Easing: HOST_ONLY,
  I18nManager: HOST_ONLY,
  InteractionManager: HOST_ONLY,
  Keyboard: HOST_ONLY,
  LayoutAnimation: HOST_ONLY,
  LogBox: HOST_ONLY,
  NativeComponentRegistry: HOST_ONLY,
  PanResponder: HOST_ONLY,
  PermissionsAndroid: HOST_ONLY,
  PixelRatio: HOST_ONLY,
  PushNotificationIOS: HOST_ONLY,
  Settings: HOST_ONLY,
  Share: HOST_ONLY,
  StyleSheet: HOST_ONLY,
  ToastAndroid: HOST_ONLY,
  UIManager: HOST_ONLY,
  Vibration: HOST_ONLY,
  codegenNativeCommands: HOST_ONLY,
  codegenNativeComponent: HOST_ONLY,
  DynamicColorIOS: HOST_ONLY,
  findNodeHandle: HOST_ONLY,
  PlatformColor: HOST_ONLY,
  processColor: HOST_ONLY,
  requireNativeComponent: HOST_ONLY,
  RootTagContext: HOST_ONLY,
  unstable_batchedUpdates: HOST_ONLY,

  useAnimatedValue: HOOK,
  useAnimatedValueXY: HOOK,
  useAnimatedColor: HOOK,
  useColorScheme: HOOK,
  usePressability: HOOK,
  useWindowDimensions: HOOK,
};

/**
 * Names that ARE usable in a worker but are not in this tier. Listing them
 * separately matters: telling someone `Blob` "is not available in a worker"
 * would be a lie, and would send them looking in the wrong place.
 */
const NOT_IN_TIER = [
  'Blob',
  'File',
  'FileReader',
  'URL',
  'URLSearchParams',
  'FormData',
  'XMLHttpRequest',
  'AppState',
  'Linking',
];

function describe(name, kind) {
  if (kind === TIER) {
    return (
      `[react-native-workers] \`${name}\` works in a worker, but is not part of ` +
      'the `minimal` worker shim.\n\n' +
      "Switch to the standard shim — `withWorkers(config, { shim: 'standard' })`, " +
      'which is the default — or import it directly from its module path to keep ' +
      'the bundle small.'
    );
  }
  return (
    `[react-native-workers] \`${name}\` ${REASON[kind]}\n\n` +
    'Worker bundles resolve `react-native` to a worker-sized shim so they do ' +
    'not embed the whole framework (~1.4 MB of bytecode each). If you need this ' +
    'export, the import is most likely reaching a code path the worker never ' +
    'runs — move it behind a check, or pass `shim: false` to `withWorkers()` in ' +
    'your Metro config to opt out.'
  );
}

/** Install throwing getters for `names`, unless already defined by a tier. */
function denyAll(target, names, kind) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(target, name)) continue;
    Object.defineProperty(target, name, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(describe(name, kind));
      },
    });
  }
}

/**
 * Called by each tier once it has defined its own exports, so that whatever the
 * tier did NOT define ends up with the right error message.
 */
function sealTier(target) {
  denyAll(target, NOT_IN_TIER, TIER);
  for (const name of Object.keys(UNAVAILABLE)) {
    denyAll(target, [name], UNAVAILABLE[name]);
  }
  // Metro's ESM interop reads this to decide how to bind `import * as RN`.
  Object.defineProperty(target, '__esModule', { value: true });
  return target;
}

exports.__rnworkersInterop = interop;
exports.__rnworkersReal = real;
exports.__rnworkersSealTier = sealTier;
