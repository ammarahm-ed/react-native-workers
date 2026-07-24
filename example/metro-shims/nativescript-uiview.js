'use strict';

/**
 * Worker-graph stub for `@nativescript/react-native`'s Fabric host component.
 *
 * The package's entry point is one module for two audiences: the interop
 * installer (`init()`, the lazy `UIView`/`UIColor`/… globals, the inline C
 * helpers) and `defineUIKitView()`, a React component that renders a native
 * host view. A worker only wants the first half, but the import is
 * unconditional, and `NativeScriptUIViewNativeComponent` reaches
 * `codegenNativeComponent` -> RN's component internals -> Animated, ScrollView,
 * FlatList, LogBox. That is ~4.5 MB of bytecode a runtime with no view tree
 * cannot use, and some of it reads UI-only exports off the worker's `react-native`
 * shim at module scope, which throws by design.
 *
 * So in worker graphs only (see `metro.config.js`), the host component resolves
 * here instead. Anything that touches it in a worker is a bug — rendering React
 * is not a thing a worker does — so make that loud rather than silent.
 */

const NAME = 'NativeScriptUIView';

module.exports = new Proxy(
  function NativeScriptUIViewUnavailableInWorker() {
    throw new Error(
      `[react-native-workers] <${NAME}> cannot render inside a worker: a worker ` +
        'runtime has no view tree. Use `defineUIKitView()` on the app side, or ' +
        'build the UIKit subtree imperatively from a UIWorker.'
    );
  },
  {
    get(target, prop) {
      if (prop === 'displayName' || prop === 'name') return NAME;
      return Reflect.get(target, prop);
    },
  }
);
module.exports.default = module.exports;
