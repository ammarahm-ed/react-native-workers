// This local Expo module exists purely to exercise Expo properties + events from
// inside a worker runtime. The main app doesn't use it directly; the worker reaches
// it via `global.expo.modules.RNWProbe`. Kept minimal on purpose.
import { requireNativeModule } from 'expo-modules-core';

export default requireNativeModule('RNWProbe');
