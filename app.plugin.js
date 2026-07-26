// Expo config plugin for @ammarahmed/react-native-workers.
//
// The library is autolinked, so on Expo the CORE features (inline + dev
// file-based workers, SharedStore/SharedValue/SharedBuffer, C++ modules, nested
// workers) need NOTHING here — just wrap metro.config.js with `withWorkers()`
// and add the Babel plugin, exactly as in bare React Native. `expo prebuild`
// runs `pod install` and Gradle autolinking, and all iOS native registration is
// done from `+load`, so iOS needs no project edits at all.
//
// This plugin exists for the two things prebuild CANNOT do on its own, because a
// managed app has no MainApplication / build.gradle / Xcode project to hand-edit:
//
//   1. androidNativeModules (default true) — inject the one-time
//      `WorkerTurboModules.initialize(...)` registration into MainApplication so
//      workers created with `{ nativeModules: true }` can resolve the app's
//      Java/Kotlin TurboModules. Harmless (and cheap) when unused, so it is on by
//      default; set `androidNativeModules: false` to skip it.
//   2. releaseBundling (default false) — wire the ahead-of-time worker-bundle
//      build step into the native builds (Android Gradle apply + iOS Xcode build
//      phase) so file-based workers load from shipped bytecode in release. Only
//      needed if you use `new Worker('./file')` and ship release builds.
//
// Usage in app.json / app.config.js:
//   ["@ammarahmed/react-native-workers", { "releaseBundling": true }]

const {
  withMainApplication,
  withAppBuildGradle,
  withXcodeProject,
  createRunOncePlugin,
} = require('@expo/config-plugins');
const {
  mergeContents,
} = require('@expo/config-plugins/build/utils/generateCode');

const pkg = require('./package.json');

// ---------------------------------------------------------------------------
// Pure transforms (exported for unit testing — no Expo context needed).
// ---------------------------------------------------------------------------

// Inject the worker TurboModule registration into MainApplication's onCreate,
// right after `loadReactNative(this)`. Fully-qualified names are used on purpose
// so no import edits are required (more robust across Expo template versions).
// Idempotent: re-running finds the tagged block and leaves it untouched.
function addAndroidWorkerModuleRegistration(contents, isKotlin) {
  const tag = 'react-native-workers-turbomodules';
  const block = isKotlin
    ? [
        '    // Let worker runtimes resolve this app’s Java/Kotlin TurboModules.',
        '    reactHost.addReactInstanceEventListener(',
        '      object : com.facebook.react.ReactInstanceEventListener {',
        '        override fun onReactContextInitialized(context: com.facebook.react.bridge.ReactContext) {',
        '          if (context is com.facebook.react.bridge.ReactApplicationContext) {',
        '            com.ammarahmed.reactnativeworkers.WorkerTurboModules.initialize(',
        '              context, com.facebook.react.PackageList(this@MainApplication).packages)',
        '          }',
        '        }',
        '      })',
      ].join('\n')
    : [
        '    // Let worker runtimes resolve this app’s Java/Kotlin TurboModules.',
        '    final android.app.Application self = this;',
        '    getReactHost().addReactInstanceEventListener(context -> {',
        '      if (context instanceof com.facebook.react.bridge.ReactApplicationContext) {',
        '        com.ammarahmed.reactnativeworkers.WorkerTurboModules.initialize(',
        '          (com.facebook.react.bridge.ReactApplicationContext) context,',
        '          new com.facebook.react.PackageList(self).getPackages());',
        '      }',
        '    });',
      ].join('\n');

  // Anchor on loadReactNative(this) — present in both Kotlin and Java Expo
  // templates (SDK 52+). Insert the block on the line after it.
  const anchor = /loadReactNative\(this\)/;
  return mergeContents({
    tag,
    src: contents,
    newSrc: block,
    anchor,
    offset: 1,
    comment: '//',
  });
}

// Apply the release worker-bundling Gradle script from the installed package.
function addAndroidWorkerBundling(contents) {
  const tag = 'react-native-workers-bundling';
  const applyLine =
    'apply from: new File(["node", "--print", "require.resolve(\'@ammarahmed/react-native-workers/package.json\')"].execute(null, rootDir).text.trim(), "../android/worker-bundles.gradle")';
  // Anchor after the react-native gradle plugin is applied (the worker-bundles
  // script needs the `react { }` extension to exist).
  const anchor = /apply plugin: ["']com\.facebook\.react["']/;
  const merged = mergeContents({
    tag,
    src: contents,
    newSrc: applyLine,
    anchor,
    offset: 1,
    comment: '//',
  });
  if (merged.didMerge) return merged;
  // Fallback: no explicit apply-plugin line (some templates use the plugins {}
  // DSL) — append at end of file, which is after the react block is configured.
  return mergeContents({
    tag,
    src: contents,
    newSrc: applyLine,
    anchor: /$(?![\r\n])/,
    offset: 0,
    comment: '//',
  });
}

// ---------------------------------------------------------------------------
// Expo plugin wrappers.
// ---------------------------------------------------------------------------

function withWorkerModuleRegistration(config) {
  return withMainApplication(config, (cfg) => {
    const isKotlin = cfg.modResults.language === 'kt';
    const result = addAndroidWorkerModuleRegistration(
      cfg.modResults.contents,
      isKotlin
    );
    cfg.modResults.contents = result.contents;
    return cfg;
  });
}

function withAndroidWorkerBundling(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg; // KTS not handled yet
    cfg.modResults.contents = addAndroidWorkerBundling(
      cfg.modResults.contents
    ).contents;
    return cfg;
  });
}

// iOS: add a "Bundle React Native worker code" build phase that runs the CLI
// before the app is signed, so release worker bytecode ships in the .app.
function withIosWorkerBundling(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const phaseName = 'Bundle React Native worker code';
    // Idempotent: skip if a phase with this name already exists.
    const already = Object.values(
      project.hash.project.objects.PBXShellScriptBuildPhase || {}
    ).some((p) => p && p.name && p.name.includes(phaseName));
    if (!already) {
      project.addBuildPhase(
        [],
        'PBXShellScriptBuildPhase',
        phaseName,
        project.getFirstTarget().uuid,
        {
          shellPath: '/bin/sh',
          shellScript: [
            'set -e',
            '',
            "# Source the same environment Expo's own bundle phase uses, so",
            '# NODE_BINARY (from .xcode.env / .xcode.env.local) is set. Without',
            "# this, node is often not on Xcode's PATH and every command below",
            '# fails.',
            'WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"',
            '',
            '# Resolve the library through its package.json, NOT through a direct',
            '# subpath: the package declares an `exports` map, so a subpath it does',
            '# not list fails with ERR_PACKAGE_PATH_NOT_EXPORTED. package.json is',
            '# always exported, so deriving the root from it always works.',
            "RESOLVE=\"require('path').dirname(require.resolve('@ammarahmed/react-native-workers/package.json'))\"",
            '',
            'bundle_workers() {',
            '  NODE="${NODE_BINARY:-node}"',
            '  LIB="$("$NODE" --print "$RESOLVE")"',
            '  SCRIPT="$LIB/scripts/ios-bundle-workers.sh"',
            '  if [ ! -f "$SCRIPT" ]; then',
            '    echo "error: react-native-workers: $SCRIPT not found." >&2',
            '    exit 1',
            '  fi',
            '  /bin/sh "$SCRIPT"',
            '}',
            '',
            '# Deliberately NOT tolerant of failure. A silently skipped worker',
            '# build produces an app whose file workers all fail at runtime with',
            '# "Failed to load bundled worker" — far worse than a red build.',
            'if [ -f "$WITH_ENVIRONMENT" ]; then',
            '  . "$WITH_ENVIRONMENT"',
            'fi',
            'bundle_workers',
          ].join('\n'),
        }
      );
    }
    return cfg;
  });
}

function withReactNativeWorkers(config, props = {}) {
  const { androidNativeModules = true, releaseBundling = false } = props;
  if (androidNativeModules) {
    config = withWorkerModuleRegistration(config);
  }
  if (releaseBundling) {
    config = withAndroidWorkerBundling(config);
    config = withIosWorkerBundling(config);
  }
  return config;
}

module.exports = createRunOncePlugin(
  withReactNativeWorkers,
  pkg.name,
  pkg.version
);

// Exposed for unit tests.
module.exports._transforms = {
  addAndroidWorkerModuleRegistration,
  addAndroidWorkerBundling,
};
