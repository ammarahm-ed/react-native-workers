# Desktop target (react-native-gpui): the C++ core compiled into the app's
# TurboModule archive, with the desktop platform layer in desktop/cpp. Each
# worker runs its own Hermes runtime (hermes::makeHermesRuntime) on its own
# thread; the headers come from the app's active JS engine.
get_filename_component(_workers_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(_workers_cpp "${_workers_root}/cpp")

set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES
  "${_workers_cpp}/ReactNativeWorkersImpl.cpp"
  "${_workers_cpp}/api/NativeWorkers.cpp"
  "${_workers_cpp}/core/MessageCodec.cpp"
  "${_workers_cpp}/core/SharedBuffer.cpp"
  "${_workers_cpp}/core/SharedStore.cpp"
  "${_workers_cpp}/core/SharedValue.cpp"
  "${_workers_cpp}/core/Worker.cpp"
  "${_workers_cpp}/runtime/HermesWorkerHost.cpp"
  "${_workers_cpp}/runtime/HostThreadWaker.cpp"
  "${_workers_cpp}/runtime/MainThreadScheduler.cpp"
  "${_workers_cpp}/runtime/ThreadTarget.cpp"
  "${_workers_cpp}/runtime/UiWorkerHost.cpp"
  "${_workers_cpp}/runtime/WorkerAssetReader.cpp"
  "${_workers_cpp}/runtime/WorkerInspector.cpp"
  "${_workers_cpp}/runtime/WorkerJsLock.cpp"
  "${_workers_cpp}/runtime/WorkerThreadScope.cpp"
  "${_workers_cpp}/bindings/WorkerBlobCollector.cpp"
  "${_workers_cpp}/bindings/WorkerExpoModules.cpp"
  "${_workers_cpp}/bindings/WorkerGlobalScope.cpp"
  "${_workers_cpp}/bindings/WorkerThreads.cpp"
  "${_workers_cpp}/bindings/WorkerTurboModules.cpp"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiWorkersModule.cpp"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/WorkerTurboModulesDesktop.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS
  "${_workers_cpp}"
  "${CMAKE_CURRENT_LIST_DIR}/cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_DEFINITIONS
  RN_WORKERS_DESKTOP=1)
