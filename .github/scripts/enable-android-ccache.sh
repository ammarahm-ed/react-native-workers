#!/usr/bin/env bash
# Point the Android NDK/CMake build at ccache for a scaffolded consumer app.
#
#   enable-android-ccache.sh <app-dir>
#
# The expensive part of an Android matrix job is compiling this library's C++
# (cpp/**, plus the RN/JSI headers it pulls in) through externalNativeBuild. CMake
# honours CMAKE_{C,CXX}_COMPILER_LAUNCHER, but the Android Gradle Plugin only
# accepts extra CMake arguments through the DSL — there is no gradle.property for
# it — so the argument has to be injected into the generated app's build.gradle.
#
# Best-effort by design: if the template's shape changes and the injection does
# not match, we log and move on. Losing the cache slows a job down; failing the
# job here would report a compatibility break that does not exist.
set -euo pipefail

APP_DIR="${1:?usage: enable-android-ccache.sh <app-dir>}"
GRADLE_FILE="$APP_DIR/android/app/build.gradle"

if ! command -v ccache >/dev/null 2>&1; then
  echo "::warning::ccache not installed; Android build will not be cached"
  exit 0
fi

if [ ! -f "$GRADLE_FILE" ]; then
  echo "::warning::no $GRADLE_FILE; skipping ccache wiring"
  exit 0
fi

if grep -q "COMPILER_LAUNCHER" "$GRADLE_FILE"; then
  echo "ccache already wired in $GRADLE_FILE"
  exit 0
fi

CCACHE_BIN="$(command -v ccache)"

python3 - "$GRADLE_FILE" "$CCACHE_BIN" <<'PY'
import re, sys

path, ccache = sys.argv[1], sys.argv[2]
src = open(path).read()

block = f'''
    externalNativeBuild {{
        cmake {{
            arguments "-DCMAKE_C_COMPILER_LAUNCHER={ccache}",
                      "-DCMAKE_CXX_COMPILER_LAUNCHER={ccache}"
        }}
    }}
'''

# Insert into the FIRST `defaultConfig {` block. Matching the brace on that exact
# line keeps this from tripping over the many other `{` in the template.
m = re.search(r'^\s*defaultConfig\s*\{\s*$', src, re.M)
if not m:
    print("::warning::could not find defaultConfig block; skipping ccache wiring")
    sys.exit(0)

insert_at = m.end()
open(path, 'w').write(src[:insert_at] + "\n" + block + src[insert_at:])
print(f"wired ccache ({ccache}) into {path}")
PY

ccache -z >/dev/null 2>&1 || true
