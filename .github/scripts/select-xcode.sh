#!/usr/bin/env bash
# Select an Xcode version on a GitHub macOS runner.
#
#   select-xcode.sh 26.1   -> /Applications/Xcode_26.1.app (or the newest 26.1.x)
#   select-xcode.sh        -> leave the runner default alone
#
# Uses xcode-select against the runner's preinstalled /Applications/Xcode_*.app
# rather than adding a third-party action, so there is no extra dependency to pin.
#
# A requested version that is not installed is a WARNING, not a failure: runner
# images drop old Xcodes over time, and a job that silently keeps building on the
# default toolchain still produces a useful (if differently-pinned) signal. The
# selected version is always printed so a surprising result is traceable in the log.
set -euo pipefail

WANT="${1:-}"

if [ -z "$WANT" ]; then
  echo "No Xcode pin requested; using runner default: $(xcodebuild -version | head -1)"
  exit 0
fi

# Exact match first (Xcode_26.1.app), then newest matching prefix (Xcode_26.1.x.app).
CANDIDATE="/Applications/Xcode_${WANT}.app"
if [ ! -d "$CANDIDATE" ]; then
  CANDIDATE=$(ls -d /Applications/Xcode_"${WANT}"*.app 2>/dev/null | sort -V | tail -1 || true)
fi

if [ -z "$CANDIDATE" ] || [ ! -d "$CANDIDATE" ]; then
  echo "::warning::Xcode ${WANT} is not installed on this runner. Available:"
  ls -d /Applications/Xcode*.app 2>/dev/null || echo "  (none found)"
  echo "Continuing with the runner default: $(xcodebuild -version | head -1)"
  exit 0
fi

sudo xcode-select -s "$CANDIDATE/Contents/Developer"
echo "Selected: $CANDIDATE"
xcodebuild -version
swift --version 2>/dev/null | head -1 || true
