#!/bin/bash
# react-native-workers — release worker bundling for iOS.
#
# Intended to run as an Xcode "Run Script" build phase that executes AFTER the
# stock "Bundle React Native code and images" phase (react-native-xcode.sh).
# It builds one standalone bundle per worker and drops them next to the app's
# main.jsbundle inside the .app resources, optionally Hermes-compiled.
#
# It mirrors react-native-xcode.sh's skip logic (SKIP_BUNDLING, Debug/simulator)
# and relies on the same Xcode-provided env vars.

# Print commands before executing them (useful for troubleshooting) and abort on
# the first error (worker builds are load-bearing for release apps).
set -x -e

# Same destination react-native-xcode.sh writes main.jsbundle into.
DEST="$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"

if [[ "$SKIP_BUNDLING" ]]; then
  echo "react-native-workers: SKIP_BUNDLING enabled; skipping worker bundling."
  exit 0
fi

# Determine dev vs release exactly like react-native-xcode.sh.
case "$CONFIGURATION" in
  *Debug*)
    if [[ "$PLATFORM_NAME" == *simulator ]]; then
      if [[ "$FORCE_BUNDLING" ]]; then
        echo "react-native-workers: FORCE_BUNDLING enabled; continuing."
      else
        echo "react-native-workers: skipping in Debug for the Simulator (Metro serves workers)."
        exit 0
      fi
    fi
    DEV=true
    ;;
  "")
    echo "react-native-workers: $0 must be invoked by Xcode" >&2
    exit 1
    ;;
  *)
    DEV=false
    ;;
esac

# Workers are only pre-bundled for release; dev fetches them from Metro.
if [[ "$DEV" == true ]]; then
  echo "react-native-workers: dev configuration; skipping worker bundling."
  exit 0
fi

# Project root: same default react-native-xcode.sh uses.
PROJECT_ROOT="${PROJECT_ROOT:-"$PROJECT_DIR/.."}"
cd "$PROJECT_ROOT" || exit 1

# Resolve NODE_BINARY the same way react-native-xcode.sh does when available.
REACT_NATIVE_DIR=$(node --print "require('path').dirname(require.resolve('react-native/package.json', {paths: [process.cwd()]}))" 2>/dev/null || echo "")
if [[ -n "$REACT_NATIVE_DIR" && -f "$REACT_NATIVE_DIR/scripts/node-binary.sh" ]]; then
  # shellcheck source=/dev/null
  source "$REACT_NATIVE_DIR/scripts/node-binary.sh"
fi
[ -z "$NODE_BINARY" ] && NODE_BINARY="node"

# Locate the installed react-native-workers package (its cli/index.js).
LIB=$("$NODE_BINARY" --print "require('path').dirname(require.resolve('@ammarahmed/react-native-workers/package.json', {paths: [process.cwd()]}))")
if [[ -z "$LIB" || ! -f "$LIB/cli/index.js" ]]; then
  echo "react-native-workers: could not locate @ammarahmed/react-native-workers CLI." >&2
  exit 1
fi

# Hermes: react-native-xcode.sh already compiled main.jsbundle. Compile workers
# with the same hermesc if Hermes is enabled and the binary is present.
HERMES_ENGINE_PATH="$PODS_ROOT/hermes-engine"
[ -z "$HERMES_CLI_PATH" ] && HERMES_CLI_PATH="$HERMES_ENGINE_PATH/destroot/bin/hermesc"
HERMES_ARGS=()
if [[ "$USE_HERMES" != false && -f "$HERMES_CLI_PATH" ]]; then
  HERMES_ARGS=(--hermes "$HERMES_CLI_PATH")
fi

# Build the worker bundles straight into the app's resources folder (DEST), so
# they sit alongside main.jsbundle and are readable by the native asset loader.
"$NODE_BINARY" "$LIB/cli/index.js" \
  --platform ios \
  --dev false \
  --out "$DEST" \
  --project-root "$PROJECT_ROOT" \
  "${HERMES_ARGS[@]}"

echo "react-native-workers: worker bundles written to $DEST/workers"
