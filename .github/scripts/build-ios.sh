#!/usr/bin/env bash
# pod install + xcodebuild for a scaffolded consumer app, with ccache.
#
#   build-ios.sh <app-dir>
#
# Two things here are load-bearing and were both real bugs in the local runner:
#
#  * The .xcworkspace is CREATED BY `pod install`, so it can only be discovered
#    afterwards. Reading the directory first finds nothing on a fresh scaffold and
#    hands xcodebuild the literal string "undefined".
#  * -derivedDataPath keeps build output inside the app dir instead of the shared
#    ~/Library/Developer/Xcode/DerivedData, so a matrix sweep cannot fill the disk
#    and each job starts from a known-empty state.
#
# ccache is enabled through React Native's own Podfile support (USE_CCACHE=1),
# which must be set at POD INSTALL time because it configures the generated Pods
# project. Driving ccache through CC/CXX wrapper scripts instead makes Xcode fail
# to recognise the compiler and silently disable explicit modules. Compiler-driver
# flags ccache cannot cache are handled by CCACHE_SLOPPINESS in the workflow env.
set -euo pipefail

APP_DIR="${1:?usage: build-ios.sh <app-dir>}"
cd "$APP_DIR"

if command -v ccache >/dev/null 2>&1; then
  export USE_CCACHE="${USE_CCACHE:-1}"
  ccache -z >/dev/null 2>&1 || true
else
  echo "::warning::ccache not found; building without it"
fi

# --- pods ------------------------------------------------------------------
cd ios
pod install

WORKSPACE=$(ls -d ./*.xcworkspace 2>/dev/null | head -1 || true)
if [ -z "$WORKSPACE" ]; then
  echo "::error::no .xcworkspace found after pod install in $PWD"
  ls -la
  exit 1
fi
WORKSPACE=$(basename "$WORKSPACE")
SCHEME="${WORKSPACE%.xcworkspace}"
echo "Building workspace=$WORKSPACE scheme=$SCHEME"

BUILD_ARGS=(
  -workspace "$WORKSPACE"
  -scheme "$SCHEME"
  -configuration Debug
  -sdk iphonesimulator
  -destination 'generic/platform=iOS Simulator'
  -derivedDataPath build/DerivedData
  build
  CODE_SIGNING_ALLOWED=NO
)

# Keep the log readable in CI but preserve the real exit status; on failure show
# enough tail to identify WHICH pod failed (ours vs an upstream dependency).
set -o pipefail
if ! xcodebuild "${BUILD_ARGS[@]}" | tail -60; then
  echo "::error::xcodebuild failed for $SCHEME"
  exit 1
fi
