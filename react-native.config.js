/**
 * @type {import('@react-native-community/cli-types').UserDependencyConfig}
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cmakeListsPath: 'generated/jni/CMakeLists.txt',
        cxxModuleCMakeListsModuleName: 'ammarahmed-react-native-workers',
        cxxModuleCMakeListsPath: 'CMakeLists.txt',
        cxxModuleHeaderName: 'ReactNativeWorkersImpl',
      },
    },
  },
};
