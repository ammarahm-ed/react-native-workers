#!/usr/bin/env bash
# Build + run the example app on a booted simulator and assert its in-app suite.
#
#   run-ios-e2e.sh
#
# The Android counterpart reads results from logcat. There is no logcat here, so
# the app is launched with `simctl launch --console-pty`, which pipes the
# process's stdout/stderr straight to us. That is why TestsScreen emits its
# summary through `nativeLoggingHook` as well as console.log: in a bridgeless dev
# build console.log goes to the DevTools channel and never reaches this stream.
#
# Expects: Metro already serving with RN_WORKERS_SCREEN=tests baked in (Babel
# inlines that at transform time, so it must be set on the Metro process).
set -euo pipefail

BUNDLE_ID="ammarahmed.reactnativeworkers.example"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)/example/ios"
DERIVED="$APP_DIR/build/DerivedData"
DEADLINE_SECS="${E2E_TIMEOUT_SECS:-600}"
LOG="${RUNNER_TEMP:-/tmp}/app-console.log"

# --- simulator -------------------------------------------------------------
# Pick the newest available iOS runtime and the newest iPhone device type rather
# than hardcoding "iPhone 16": runner images rotate both, and a stale literal
# fails as an unhelpful "invalid device" months later.
echo "::group::Create + boot simulator"
# Via a temp file, not a pipe: the picker is a quoted heredoc (so nothing in it
# is shell-expanded), which means it owns stdin and cannot also read the pipe.
SIMJSON="${RUNNER_TEMP:-/tmp}/simctl-devices.json"
xcrun simctl list --json devicetypes runtimes > "$SIMJSON"
DEVICE_ID=$(python3 - "$SIMJSON" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))

def ver(s):
    return [int(x) for x in re.findall(r"\d+", s)]

runtimes = [r for r in d["runtimes"]
            if r.get("isAvailable") and "iOS" in r.get("name", "")]
if not runtimes:
    sys.exit("no available iOS runtime")
runtime = max(runtimes, key=lambda r: ver(r["version"]))

# Only device types the chosen runtime actually supports — creating an
# unsupported pair fails at `simctl create`, not at boot.
supported = {t["identifier"] for t in runtime.get("supportedDeviceTypes", [])}
phones = [t for t in d["devicetypes"]
          if t["identifier"].startswith("com.apple.CoreSimulator.SimDeviceType.iPhone")
          and (not supported or t["identifier"] in supported)]
if not phones:
    sys.exit("no iPhone device type for %s" % runtime["name"])

# Prefer a plain numbered "iPhone <n>[ Pro…]" over "iPhone SE (3rd generation)",
# whose number is a generation and would sort nonsensically against it.
def rank(t):
    m = re.match(r"iPhone (\d+)", t["name"])
    return (1 if m else 0, int(m.group(1)) if m else 0, t["name"])

phone = max(phones, key=rank)

print(f'{phone["identifier"]}\t{runtime["identifier"]}\t{phone["name"]} / {runtime["name"]}',
      file=sys.stderr)
print(f'{phone["identifier"]}|{runtime["identifier"]}')
PY
)
DEVTYPE="${DEVICE_ID%%|*}"
RUNTIME="${DEVICE_ID##*|}"

xcrun simctl delete rnworkers-e2e >/dev/null 2>&1 || true
UDID=$(xcrun simctl create rnworkers-e2e "$DEVTYPE" "$RUNTIME")
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
echo "booted $UDID"
echo "::endgroup::"

# --- build -----------------------------------------------------------------
echo "::group::pod install + build"
cd "$APP_DIR"
pod install

BUILD_ARGS=(
  -workspace ReactNativeWorkersExample.xcworkspace
  -scheme ReactNativeWorkersExample
  -configuration Debug
  -sdk iphonesimulator
  -destination "id=$UDID"
  -derivedDataPath "$DERIVED"
  build
  CODE_SIGNING_ALLOWED=NO
)

# Same ccache wiring as build-ios.sh: Xcode calls our wrapper, which forwards to
# ccache. Absent ccache is a warning, not a failure — a slow build still gives
# the signal this job exists for.
CCACHE_BIN="$(command -v ccache || true)"
if [ -n "$CCACHE_BIN" ]; then
  WRAPPER_DIR="$APP_DIR/.ccache-bin"
  mkdir -p "$WRAPPER_DIR"
  printf '#!/bin/sh\nexec "%s" clang "$@"\n' "$CCACHE_BIN" > "$WRAPPER_DIR/ccache-clang"
  printf '#!/bin/sh\nexec "%s" clang++ "$@"\n' "$CCACHE_BIN" > "$WRAPPER_DIR/ccache-clang++"
  chmod +x "$WRAPPER_DIR/ccache-clang" "$WRAPPER_DIR/ccache-clang++"
  BUILD_ARGS+=(
    CC="$WRAPPER_DIR/ccache-clang"
    CXX="$WRAPPER_DIR/ccache-clang++"
    LD="$WRAPPER_DIR/ccache-clang"
    LDPLUSPLUS="$WRAPPER_DIR/ccache-clang++"
  )
else
  echo "::warning::ccache not found; building without it"
fi

set -o pipefail
xcodebuild "${BUILD_ARGS[@]}" | tail -40
echo "::endgroup::"

APP=$(find "$DERIVED/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)
[ -n "$APP" ] || { echo "::error::no .app produced under $DERIVED"; exit 1; }

# --- run -------------------------------------------------------------------
# Crash reports are the iOS equivalent of logcat's "Abort message". Clear them
# first so a stale report from an earlier run cannot fail this one.
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
mkdir -p "$CRASH_DIR"
find "$CRASH_DIR" -name 'ReactNativeWorkersExample*' -delete 2>/dev/null || true

xcrun simctl install "$UDID" "$APP"
# --console-pty streams the app's output here; backgrounded so we can poll the
# log while it runs. The app staying alive is itself part of the assertion.
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" > "$LOG" 2>&1 &
LAUNCH_PID=$!

echo "Waiting up to ${DEADLINE_SECS}s for the suite to report…"
START=$(date +%s)
RESULT_LINE=""
while :; do
  RESULT_LINE=$(grep "RNWORKERS-RESULTS" "$LOG" 2>/dev/null | tail -1 || true)
  [ -n "$RESULT_LINE" ] && break

  # The console process ending before results means the app died.
  if ! kill -0 "$LAUNCH_PID" 2>/dev/null; then
    echo "::error::App exited before reporting results"
    tail -60 "$LOG" || true
    exit 1
  fi

  if [ $(( $(date +%s) - START )) -gt "$DEADLINE_SECS" ]; then
    echo "::error::Timed out waiting for RNWORKERS-RESULTS"
    tail -60 "$LOG" || true
    exit 1
  fi
  sleep 5
done

kill "$LAUNCH_PID" 2>/dev/null || true

echo "::group::Raw result line"
echo "$RESULT_LINE" | cut -c1-400
echo "::endgroup::"

# A crash AFTER reporting still matters — teardown is where worker bugs surface.
CRASHES=$(find "$CRASH_DIR" -name 'ReactNativeWorkersExample*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$CRASHES" != "0" ]; then
  echo "--- crash reports ---"
  find "$CRASH_DIR" -name 'ReactNativeWorkersExample*' -exec head -40 {} \; 2>/dev/null || true
fi

python3 "$(dirname "$0")/assert_suite.py" "$RESULT_LINE" "$CRASHES"
