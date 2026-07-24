/**
 * The worker shim stands in for the `react-native` barrel inside worker
 * bundles. Its contract is narrow but load-bearing: worker-legal exports must
 * resolve lazily to the real module, and everything else must fail loudly with
 * a message that says why — a silent `undefined` would surface as an
 * unattributable crash deep inside a third-party library.
 */

import { describe, expect, it } from '@jest/globals';

const STANDARD = '../../worker-shim/react-native.js';
const MINIMAL = '../../worker-shim/react-native.minimal.js';

const load = (p: string): any => require(p);

describe('worker shim', () => {
  it('resolves native-module access from the real modules', () => {
    const RN = load(STANDARD);
    // Platform is the canonical thing third-party native modules read at
    // module scope (`Platform.select(...)` in their linking-error string).
    // The deep path is an ES module, so the shim has to unwrap `.default` —
    // getting that wrong yields `Platform.OS === undefined`, which reads as a
    // broken platform check rather than a broken import.
    // eslint-disable-next-line @react-native/no-deep-imports
    const direct = require('react-native/Libraries/Utilities/Platform');
    expect(RN.Platform.OS).toBe((direct.default ?? direct).OS);
    expect(RN.Platform.OS).toBeDefined();
    expect(typeof RN.TurboModuleRegistry.get).toBe('function');
    expect(RN.NativeModules).toBeDefined();
    expect(typeof RN.DeviceEventEmitter.addListener).toBe('function');
  });

  it('throws a UI-specific error for components', () => {
    const RN = load(STANDARD);
    expect(() => RN.View).toThrow(/`View` is a UI component/);
    expect(() => RN.FlatList).toThrow(/no view tree/);
  });

  it('throws a host-runtime error for UI-owning APIs', () => {
    const RN = load(STANDARD);
    expect(() => RN.StyleSheet).toThrow(/not available inside a worker/);
    expect(() => RN.Animated).toThrow(/host runtime that owns the UI/);
  });

  it('names the escape hatch so the error is actionable', () => {
    const RN = load(STANDARD);
    expect(() => RN.Dimensions).toThrow(/withWorkers\(\)/);
  });

  it('provides data types and networking in the standard tier', () => {
    const RN = load(STANDARD);
    expect(typeof RN.Blob).toBe('function');
    expect(typeof RN.FormData).toBe('function');
    expect(typeof RN.XMLHttpRequest).toBe('function');
    expect(typeof RN.URL).toBe('function');
  });

  it('tells the truth about tier-gated exports in the minimal shim', () => {
    const RN = load(MINIMAL);
    // `Blob` DOES work in a worker — the minimal error must say "not in this
    // tier", not "not available in a worker", or it sends people looking in
    // entirely the wrong place.
    expect(() => RN.Blob).toThrow(/works in a worker/);
    expect(() => RN.Blob).toThrow(/minimal/);
    // ...while genuinely host-only exports keep the host-only explanation.
    expect(() => RN.View).toThrow(/is a UI component/);
  });

  it('keeps core exports in the minimal shim', () => {
    const RN = load(MINIMAL);
    expect(RN.Platform.OS).toBeDefined();
    expect(RN.NativeModules).toBeDefined();
  });

  it('memoises lazy exports rather than re-resolving them', () => {
    const RN = load(STANDARD);
    expect(RN.Platform).toBe(RN.Platform);
  });
});
