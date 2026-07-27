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
# ccache is wired through the CC/CXX build settings (the approach React Native
# documents): Xcode invokes our wrapper, which forwards to ccache. Compiler-driver
# flags Xcode passes that ccache cannot cache are handled by CCACHE_SLOPPINESS,
# set in the workflow env.
set -euo pipefail

APP_DIR="${1:?usage: build-ios.sh <app-dir>}"
cd "$APP_DIR"

# --- ccache wrappers -------------------------------------------------------
# Written next to the app so the paths are stable for the whole build.
WRAPPER_DIR="$PWD/.ccache-bin"
mkdir -p "$WRAPPER_DIR"
CCACHE_BIN="$(command -v ccache || true)"

USE_CCACHE=0
if [ -n "$CCACHE_BIN" ]; then
  USE_CCACHE=1
  cat > "$WRAPPER_DIR/ccache-clang" <<EOF
#!/bin/sh
exec "$CCACHE_BIN" clang "\$@"
EOF
  cat > "$WRAPPER_DIR/ccache-clang++" <<EOF
#!/bin/sh
exec "$CCACHE_BIN" clang++ "\$@"
EOF
  chmod +x "$WRAPPER_DIR/ccache-clang" "$WRAPPER_DIR/ccache-clang++"
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

if [ "$USE_CCACHE" = "1" ]; then
  BUILD_ARGS+=(
    CC="$WRAPPER_DIR/ccache-clang"
    CXX="$WRAPPER_DIR/ccache-clang++"
    LD="$WRAPPER_DIR/ccache-clang"
    LDPLUSPLUS="$WRAPPER_DIR/ccache-clang++"
  )
fi

# Keep the log readable in CI but preserve the real exit status; on failure show
# enough tail to identify WHICH pod failed (ours vs an upstream dependency).
set -o pipefail
if ! xcodebuild "${BUILD_ARGS[@]}" | tail -60; then
  echo "::error::xcodebuild failed for $SCHEME"
  exit 1
fi
