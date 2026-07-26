/**
 * @type {import('@react-native-community/cli-types').UserDependencyConfig}
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        // The library does NOT ship generated codegen (android/generated is
        // excluded from the npm tarball so each app generates its own correctly
        // versioned spec). So point at the build-dir location where the app's
        // codegen writes it — RN's default — rather than a shipped `generated/jni`.
        cmakeListsPath: 'build/generated/source/codegen/jni/CMakeLists.txt',
        cxxModuleCMakeListsModuleName: 'ammarahmed-react-native-workers',
        cxxModuleCMakeListsPath: 'CMakeLists.txt',
        cxxModuleHeaderName: 'ReactNativeWorkersImpl',
      },
    },
  },
};
