cmake_minimum_required(VERSION 3.4.1)
project(ReactNativeWorkers)

set (CMAKE_VERBOSE_MAKEFILE ON)

add_library(
    ammarahmed-react-native-workers    STATIC
    ../cpp/ReactNativeWorkersImpl.cpp
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

target_link_libraries(
    ammarahmed-react-native-workers    jsi
    reactnative
    react_codegen_ReactNativeWorkersSpec
)
