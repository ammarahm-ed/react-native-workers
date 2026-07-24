cmake_minimum_required(VERSION 3.13)
project(UIWorkerDemo)

set(CMAKE_VERBOSE_MAKEFILE ON)

# fbjni: the Kotlin platform layer is called directly from C++ (no queue hop).
find_package(fbjni REQUIRED CONFIG)
# ReactAndroid: `reactnative` carries TurboModule + registerCxxModuleToGlobalModuleMap.
find_package(ReactAndroid REQUIRED CONFIG)

# SHARED, not STATIC, and deliberately so: the module registers itself from
# JNI_OnLoad, and a static archive whose objects nothing references can be
# dropped by the linker — taking the registration with it. Its own .so is loaded
# explicitly by UIWorkerDemoPackage, so the entry point always runs.
add_library(
    uiworkerdemo    SHARED
    ../cpp/UIWorkerDemoModule.cpp
    src/main/cpp/UIWorkerDemoAndroid.cpp
)

set_target_properties(
    uiworkerdemo PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)

target_include_directories(
    uiworkerdemo    PRIVATE
    ../cpp
)

target_link_libraries(
    uiworkerdemo
    ReactAndroid::jsi
    ReactAndroid::reactnative
    fbjni::fbjni
    android
    log
)
