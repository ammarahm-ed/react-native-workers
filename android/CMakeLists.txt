cmake_minimum_required(VERSION 3.4.1)
project(ReactNativeWorkers)

set (CMAKE_VERBOSE_MAKEFILE ON)

# We create a second Hermes runtime via hermes::makeHermesRuntime, so we need the
# hermes-engine prefab (target hermes-engine::hermesvm) which ships <hermes/hermes.h>.
find_package(hermes-engine REQUIRED CONFIG)
# fbjni bridges each worker runtime to the app's Java TurboModules
# (WorkerTurboModulesAndroid.cpp): building the worker-bound CallInvoker /
# RuntimeExecutor holders and calling the Kotlin WorkerTurboModules bridge.
find_package(fbjni REQUIRED CONFIG)

add_library(
    ammarahmed-react-native-workers    STATIC
    ../cpp/ReactNativeWorkersImpl.cpp
    ../cpp/core/MessageCodec.cpp
    ../cpp/core/SharedBuffer.cpp
    ../cpp/core/SharedStore.cpp
    ../cpp/core/SharedValue.cpp
    ../cpp/core/Worker.cpp
    ../cpp/runtime/HermesWorkerHost.cpp
    ../cpp/runtime/MainThreadScheduler.cpp
    ../cpp/runtime/MainThreadSchedulerAndroid.cpp
    ../cpp/runtime/UiWorkerHost.cpp
    ../cpp/runtime/WorkerAssetReader.cpp
    ../cpp/runtime/WorkerAssetReaderAndroid.cpp
    ../cpp/runtime/WorkerInspector.cpp
    ../cpp/runtime/WorkerThreadScope.cpp
    ../cpp/bindings/WorkerBlobCollector.cpp
    ../cpp/bindings/WorkerGlobalScope.cpp
    ../cpp/bindings/WorkerTurboModules.cpp
    ../cpp/bindings/WorkerTurboModulesAndroid.cpp
    ../cpp/api/NativeWorkers.cpp
)

set_target_properties(
    ammarahmed-react-native-workers PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)

target_include_directories(
    ammarahmed-react-native-workers    PUBLIC
    ../cpp
)

# RN JNI hybrid headers (CallInvokerHolder / NativeMethodCallInvokerHolder /
# JRuntimeExecutor) and the header-only RuntimeExecutor live in the react-native
# source tree, not in the prefab. REACT_ANDROID_DIR / REACT_COMMON_DIR are set by
# ReactNative-application.cmake, which add_subdirectory()'s this file.
target_include_directories(
    ammarahmed-react-native-workers    PRIVATE
    ${REACT_ANDROID_DIR}/src/main/jni
    ${REACT_COMMON_DIR}/runtimeexecutor
)

target_link_libraries(
    ammarahmed-react-native-workers    jsi
    reactnative
    react_codegen_ReactNativeWorkersSpec
    hermes-engine::hermesvm
    fbjni::fbjni
    log
)
