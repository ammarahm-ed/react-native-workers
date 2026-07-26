#!/bin/bash
# Generate launcher icons for the example apps from example/assets/icon/*.svg.
#
# Those SVGs are themselves derived from the site logo (docs/static/img/logo.svg)
# — same two gears, same colours — minus the rounded corners and the animation,
# neither of which belongs in an app icon: iOS and Android apply their own mask,
# so a baked-in radius shows up as a visible inset inside theirs.
#
# Requires ImageMagick 7 (`brew install imagemagick`).
#
#   ./scripts/generate-app-icons.sh
#
# Re-run after editing the source SVGs. Everything it writes is committed, so a
# normal build never needs this.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/example/assets/icon"
MASTER="$SRC/icon.svg"
FOREGROUND="$SRC/icon-foreground.svg"

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 7 (magick) not found. brew install imagemagick" >&2
  exit 1
fi

for f in "$MASTER" "$FOREGROUND"; do
  [ -f "$f" ] || { echo "error: missing $f" >&2; exit 1; }
done

# Render an SVG at a given pixel size. -density is set high before rasterising so
# the vector is sampled well above the target and downsampled, rather than being
# rendered at the target size and looking ragged at small sizes.
render() { # render <svg> <size> <out>
  magick -background none -density 1024 "$1" -resize "${2}x${2}" -strip "$3"
}

# ---------------------------------------------------------------------------
# iOS — example/ios/.../Images.xcassets/AppIcon.appiconset
# ---------------------------------------------------------------------------
IOS_SET="$ROOT/example/ios/ReactNativeWorkersExample/Images.xcassets/AppIcon.appiconset"
mkdir -p "$IOS_SET"

# App Store review rejects an icon with an alpha channel, and the simulator
# renders one with a black fringe — flatten onto the brand background.
for size in 40 58 60 80 87 120 180 1024; do
  render "$MASTER" "$size" "$IOS_SET/icon-${size}.png"
  magick "$IOS_SET/icon-${size}.png" -background "#1F2229" -alpha remove -alpha off \
    "$IOS_SET/icon-${size}.png"
done

cat > "$IOS_SET/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon-40.png",   "idiom" : "iphone", "scale" : "2x", "size" : "20x20" },
    { "filename" : "icon-60.png",   "idiom" : "iphone", "scale" : "3x", "size" : "20x20" },
    { "filename" : "icon-58.png",   "idiom" : "iphone", "scale" : "2x", "size" : "29x29" },
    { "filename" : "icon-87.png",   "idiom" : "iphone", "scale" : "3x", "size" : "29x29" },
    { "filename" : "icon-80.png",   "idiom" : "iphone", "scale" : "2x", "size" : "40x40" },
    { "filename" : "icon-120.png",  "idiom" : "iphone", "scale" : "3x", "size" : "40x40" },
    { "filename" : "icon-120.png",  "idiom" : "iphone", "scale" : "2x", "size" : "60x60" },
    { "filename" : "icon-180.png",  "idiom" : "iphone", "scale" : "3x", "size" : "60x60" },
    { "filename" : "icon-1024.png", "idiom" : "ios-marketing", "scale" : "1x", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

echo "ios: wrote 8 icons + Contents.json"

# ---------------------------------------------------------------------------
# Android — example/android/app/src/main/res
# ---------------------------------------------------------------------------
RES="$ROOT/example/android/app/src/main/res"

# Legacy launcher icons (pre-API 26) at 48dp, and the adaptive-icon foreground
# layer at 108dp, per density bucket.
set -- "mdpi 48 108" "hdpi 72 162" "xhdpi 96 216" "xxhdpi 144 324" "xxxhdpi 192 432"
for entry in "$@"; do
  # shellcheck disable=SC2086
  set -- $entry
  density="$1"; legacy="$2"; adaptive="$3"
  dir="$RES/mipmap-$density"
  mkdir -p "$dir"

  render "$MASTER" "$legacy" "$dir/ic_launcher.png"

  # Round variant: same art, circular mask, for launchers that ask for it.
  magick "$dir/ic_launcher.png" \
    \( -size "${legacy}x${legacy}" xc:none -fill white \
       -draw "circle $((legacy/2)),$((legacy/2)) $((legacy/2)),0" \) \
    -alpha off -compose CopyOpacity -composite "$dir/ic_launcher_round.png"

  # Adaptive foreground is transparent — the background layer is a flat colour.
  render "$FOREGROUND" "$adaptive" "$dir/ic_launcher_foreground.png"
done

mkdir -p "$RES/mipmap-anydpi-v26" "$RES/values"

cat > "$RES/mipmap-anydpi-v26/ic_launcher.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML

cp "$RES/mipmap-anydpi-v26/ic_launcher.xml" "$RES/mipmap-anydpi-v26/ic_launcher_round.xml"

cat > "$RES/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Brand background behind the adaptive-icon foreground layer. -->
    <color name="ic_launcher_background">#1F2229</color>
</resources>
XML

echo "android: wrote 5 densities (legacy + round + adaptive foreground) + adaptive XML"

# ---------------------------------------------------------------------------
# expo-example — Expo generates the per-density icons itself during prebuild, so
# it only needs the two source images app.json points at.
# ---------------------------------------------------------------------------
EXPO_ASSETS="$ROOT/expo-example/assets"
mkdir -p "$EXPO_ASSETS"

render "$MASTER" 1024 "$EXPO_ASSETS/icon.png"
magick "$EXPO_ASSETS/icon.png" -background "#1F2229" -alpha remove -alpha off \
  "$EXPO_ASSETS/icon.png"
render "$FOREGROUND" 1024 "$EXPO_ASSETS/adaptive-icon.png"

echo "expo-example: wrote icon.png + adaptive-icon.png"
echo "done."
