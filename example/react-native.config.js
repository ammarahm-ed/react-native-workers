const path = require('path');
const pkg = require('../package.json');

module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    // Example-only native module (repo-local, not published). Lives in
    // example-modules/ so nothing demo-specific leaks into the library.
    'react-native-uiworker-demo': {
      root: path.join(__dirname, '..', 'example-modules', 'uiworker-demo'),
      platforms: {
        ios: {},
        // Named explicitly: the CLI infers the package class by scanning the
        // Kotlin sources, and it picks the wrong symbol here.
        android: {
          sourceDir: path.join(
            __dirname,
            '..',
            'example-modules',
            'uiworker-demo',
            'android'
          ),
          packageImportPath: 'import com.uiworkerdemo.UIWorkerDemoPackage;',
          packageInstance: 'new UIWorkerDemoPackage()',
        },
      },
    },
    [pkg.name]: {
      root: path.join(__dirname, '..'),
      platforms: {
        // Codegen script incorrectly fails without this
        // So we explicitly specify the platforms with empty object
        ios: {},
        android: {},
      },
    },
    // NativeScript's Native API interop is iOS-only (it is the napi-ios
    // project): the package ships no Android sources, only a `codegenConfig`
    // android entry that would have RN codegen emit a Java spec with nothing
    // behind it. Keep it off the Android build entirely.
    '@nativescript/react-native': {
      platforms: {
        android: null,
      },
    },
    // react-native-gzip's podspec still depends on RCT-Folly, which RN 0.85
    // replaced with ReactNativeDependencies, so it cannot link on iOS. It is
    // only used by the Android legacy-native-module test.
    'react-native-gzip': {
      platforms: {
        ios: null,
      },
    },
    // react-native-mmkv-storage (MMKVCore ~1.3) and react-native-mmkv
    // (MMKVCore 2.4) pull incompatible versions of the same native pod, so only
    // one of the two can be linked on iOS at a time. Both are exercised on
    // Android; flip these two entries to test the other one on iOS.
    'react-native-mmkv-storage': {
      platforms: {
        ios: null,
      },
    },
  },
};
