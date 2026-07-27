#!/usr/bin/env bash
# Build + run the example app on a booted emulator and assert its in-app suite.
#
#   run-android-e2e.sh
#
# Why this exists: the compat matrix only COMPILES. Every one of the worst bugs
# found while building the Thread API and the Expo SDK 56+ bridge was invisible to
# a compiler — an installer that compiled out entirely, a SIGSEGV from a
# main-runtime lambda holding a worker jsi::Function, listeners duplicating on
# every subscribe/remove cycle. Only running the suite catches those.
#
# Expects: an emulator already booted, Metro already serving with
# RN_WORKERS_SCREEN=tests baked in (that env is inlined by Babel at transform
# time, so Metro must have been started with it — see example/babel.config.js).
set -euo pipefail

PKG="ammarahmed.reactnativeworkers.example"
DEADLINE_SECS="${E2E_TIMEOUT_SECS:-600}"

echo "::group::Build + install the example app"
adb logcat -c || true
yarn example android
echo "::endgroup::"

echo "Waiting up to ${DEADLINE_SECS}s for the suite to report…"
START=$(date +%s)
RESULT_LINE=""
while :; do
  # -v raw keeps the payload intact; the results line is a single long JSON blob.
  RESULT_LINE=$(adb logcat -d -v raw 2>/dev/null | grep "RNWORKERS-RESULTS" | tail -1 || true)
  [ -n "$RESULT_LINE" ] && break

  # A native abort will never produce a results line — fail fast instead of
  # burning the whole timeout.
  if adb logcat -d 2>/dev/null | grep -qE "Abort message|FATAL EXCEPTION"; then
    echo "::error::App crashed before reporting results"
    adb logcat -d 2>/dev/null | grep -B5 -A30 -E "Abort message|FATAL EXCEPTION" | head -60
    exit 1
  fi

  if [ $(( $(date +%s) - START )) -gt "$DEADLINE_SECS" ]; then
    echo "::error::Timed out waiting for RNWORKERS-RESULTS"
    echo "--- last JS logs ---"
    adb logcat -d 2>/dev/null | grep -E "ReactNativeJS|RNWorker" | tail -40
    exit 1
  fi
  sleep 5
done

echo "::group::Raw result line"
echo "$RESULT_LINE" | cut -c1-400
echo "::endgroup::"

# A crash AFTER reporting still matters (teardown paths are where worker bugs
# tend to surface), so check regardless of the result line.
CRASHES=$(adb logcat -d 2>/dev/null | grep -cE "Abort message|FATAL EXCEPTION" || true)

python3 - "$RESULT_LINE" "$CRASHES" <<'PY'
import re, sys

line, crashes = sys.argv[1], int(sys.argv[2] or 0)

m = re.search(r'RNWORKERS-RESULTS\]\s+(\d+)/(\d+)', line)
if not m:
    print("::error::could not parse the results header")
    sys.exit(1)
passed, total = int(m.group(1)), int(m.group(2))

# logcat truncates very long lines, so parse entries leniently rather than
# requiring the JSON array to be closed.
entries = re.findall(r'\{"n":"(.*?)","p":(true|false)(?:,"d":"(.*?)")?', line)
failures = [(n, d) for n, p, d in entries if p == 'false']

print(f"suite: {passed}/{total} passed  ({len(entries)} entries parsed from the log)")
for n, d in failures:
    print(f"::error::FAILED {n} — {d or 'no detail'}")

if crashes:
    print(f"::error::{crashes} native crash marker(s) in logcat")

if passed != total or failures or crashes:
    sys.exit(1)
print("All tests passed with no native crashes.")
PY
