#!/usr/bin/env bash
set -euo pipefail

# Builds docs/assets/hero.png and docs/assets/demo.gif from two real captures of
# the live SwiftBar plugin:
#
#   docs/assets/sources/menubar-title-<date>.png  menu bar title image (transparent)
#   docs/assets/sources/menubar-panel-<date>.png  opened dropdown (transparent + shadow)
#
# Both are captured with the macOS window screenshot shortcut, so they keep their
# alpha channel and native drop shadow. This script only places them on a desktop
# backdrop and animates opening and closing the menu. Usage numbers are never
# altered.
#
# To refresh after a release: capture both images, drop them in docs/assets/sources/,
# point TITLE_IMAGE and PANEL_IMAGE at them, and re-run this script.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TITLE_IMAGE="$ROOT_DIR/docs/assets/sources/menubar-title-20260826.png"
PANEL_IMAGE="$ROOT_DIR/docs/assets/sources/menubar-panel-20260826.png"
OUTPUT_GIF="$ROOT_DIR/docs/assets/demo.gif"
OUTPUT_HERO="$ROOT_DIR/docs/assets/hero.png"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coding-usage-bar-demo.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

SYSTEM_FONT="/System/Library/Fonts/SFNS.ttf"
CLOCK_TEXT="14:37"

# Layout, in captured (2x) pixels.
MENU_HEIGHT=56
PANEL_SHADOW_INSET=48   # transparent shadow margin inside PANEL_IMAGE
TITLE_SHADOW_INSET=6    # transparent margin inside TITLE_IMAGE
SIDE_MARGIN=88
RIGHT_EXTRA=190       # room for the menu bar clock next to the title image
GAP_BELOW_PANEL=44
FRAME=0

command -v magick >/dev/null 2>&1 || {
  echo "ImageMagick is required: brew install imagemagick" >&2
  exit 1
}

for image in "$TITLE_IMAGE" "$PANEL_IMAGE"; do
  test -f "$image" || {
    echo "Source capture not found: $image" >&2
    exit 1
  }
done

read -r TITLE_W TITLE_H < <(magick identify -format '%w %h' "$TITLE_IMAGE"; echo)
read -r PANEL_W PANEL_H < <(magick identify -format '%w %h' "$PANEL_IMAGE"; echo)

CANVAS_W=$((PANEL_W + 2 * SIDE_MARGIN + RIGHT_EXTRA))
CANVAS_H=$((MENU_HEIGHT + PANEL_H + GAP_BELOW_PANEL))
PANEL_X=$SIDE_MARGIN
PANEL_Y=$((MENU_HEIGHT - PANEL_SHADOW_INSET / 2))
# Align the visible left edge of the title with the visible left edge of the panel.
TITLE_X=$((PANEL_X + PANEL_SHADOW_INSET - TITLE_SHADOW_INSET))
TITLE_Y=$(((MENU_HEIGHT - TITLE_H) / 2))
REVEAL_TOP=$((PANEL_Y))
REVEAL_SPAN=$((PANEL_H))

frame_path() {
  printf '%s/frame-%03d.png' "$WORK_DIR" "$1"
}

build_backdrop() {
  magick -size "${CANVAS_W}x${CANVAS_H}" xc:'#8FA4B6' "$WORK_DIR/desktop.png"

  # Light macOS menu bar with the real plugin title image and a system-font clock.
  magick "$WORK_DIR/desktop.png" \
    \( -size "${CANVAS_W}x${MENU_HEIGHT}" xc:'#FFFFFFB8' \) -geometry +0+0 -composite \
    \( -size "${CANVAS_W}x1" xc:'#00000022' \) -geometry "+0+$((MENU_HEIGHT - 1))" -composite \
    "$TITLE_IMAGE" -geometry "+${TITLE_X}+${TITLE_Y}" -composite \
    -font "$SYSTEM_FONT" -pointsize 26 -fill '#1D1D1FDD' -gravity NorthEast \
    -annotate "+$((SIDE_MARGIN / 2))+$(((MENU_HEIGHT - 26) / 2 + 2))" "$CLOCK_TEXT" \
    "$WORK_DIR/closed.png"

  # A window capture of a vibrant menu loses its backdrop and lands flat grey.
  # Lift the midtones and put back the saturation the flat capture cost, so the
  # panel reads the way it does on screen. Hues are untouched, so no usage value
  # changes colour band.
  magick "$PANEL_IMAGE" -channel RGB -level '0%,100%,1.18' +channel \
    -modulate 100,118 "$WORK_DIR/panel.png"

  magick "$WORK_DIR/closed.png" \
    "$WORK_DIR/panel.png" -geometry "+${PANEL_X}+${PANEL_Y}" -composite \
    "$WORK_DIR/open.png"
}

render_cursor() {
  local source="$1" output="$2" x="$3" y="$4" ring_radius="$5"
  local cursor_path="path 'M ${x},${y} L ${x},$((y + 36)) L $((x + 10)),$((y + 26)) L $((x + 18)),$((y + 43)) L $((x + 26)),$((y + 39)) L $((x + 18)),$((y + 24)) L $((x + 33)),$((y + 24)) Z'"

  if ((ring_radius > 0)); then
    magick "$source" \
      -fill none -stroke '#0A84FFAA' -strokewidth 4 \
      -draw "circle ${x},${y} $((x + ring_radius)),${y}" \
      -fill white -stroke '#111827' -strokewidth 3 \
      -draw "$cursor_path" \
      "$output"
    return
  fi

  magick "$source" \
    -fill white -stroke '#111827' -strokewidth 3 \
    -draw "$cursor_path" \
    "$output"
}

append_closed_frame() {
  render_cursor "$WORK_DIR/closed.png" "$(frame_path "$FRAME")" "$1" "$2" "$3"
  FRAME=$((FRAME + 1))
}

append_reveal_frame() {
  local reveal_height="$1" cursor_x="$2" cursor_y="$3" ring_radius="$4"

  if ((reveal_height <= 0)); then
    cp "$WORK_DIR/closed.png" "$WORK_DIR/composed.png"
  elif ((reveal_height >= REVEAL_SPAN)); then
    cp "$WORK_DIR/open.png" "$WORK_DIR/composed.png"
  else
    magick "$WORK_DIR/open.png" \
      -crop "${CANVAS_W}x${reveal_height}+0+${REVEAL_TOP}" +repage \
      "$WORK_DIR/slice.png"
    magick "$WORK_DIR/closed.png" "$WORK_DIR/slice.png" \
      -geometry "+0+${REVEAL_TOP}" -composite "$WORK_DIR/composed.png"
  fi

  render_cursor "$WORK_DIR/composed.png" "$(frame_path "$FRAME")" "$cursor_x" "$cursor_y" "$ring_radius"
  FRAME=$((FRAME + 1))
}

build_backdrop

CLICK_X=$((TITLE_X + TITLE_W / 2))
CLICK_Y=$((MENU_HEIGHT / 2 - 4))
START_X=$((CANVAS_W - SIDE_MARGIN * 2))
START_Y=$((MENU_HEIGHT + 260))

# Move the cursor to the menu bar item.
for step in {0..11}; do
  append_closed_frame \
    $((START_X + (CLICK_X - START_X) * step / 11)) \
    $((START_Y + (CLICK_Y - START_Y) * step / 11)) \
    0
done

# Click.
for ring_radius in 0 7 14 22 30 18; do
  append_closed_frame "$CLICK_X" "$CLICK_Y" "$ring_radius"
done

# Open, hold, click again, close.
for step in {1..10}; do
  append_reveal_frame $((REVEAL_SPAN * step * (20 - step) / 100)) "$CLICK_X" "$CLICK_Y" 0
done

for _ in {1..18}; do
  append_reveal_frame "$REVEAL_SPAN" "$CLICK_X" "$CLICK_Y" 0
done

for ring_radius in 0 7 14 22 30 18; do
  append_reveal_frame "$REVEAL_SPAN" "$CLICK_X" "$CLICK_Y" "$ring_radius"
done

for step in {9..0}; do
  append_reveal_frame $((REVEAL_SPAN * step * (20 - step) / 100)) "$CLICK_X" "$CLICK_Y" 0
done

for _ in {1..8}; do
  append_closed_frame "$CLICK_X" "$CLICK_Y" 0
done

GIF_WIDTH=960
HERO_WIDTH=1100
magick "$WORK_DIR/open.png" -resize "${HERO_WIDTH}x" -strip -dither None -colors 256 \
  -define png:compression-level=9 "$OUTPUT_HERO"
magick -delay 8 -loop 0 "$WORK_DIR"/frame-*.png \
  -resize "${GIF_WIDTH}x" \
  -dither None -colors 96 -fuzz 2% -layers OptimizeTransparency -layers Optimize \
  "$OUTPUT_GIF"

echo "Generated $OUTPUT_HERO"
echo "Generated $OUTPUT_GIF ($FRAME frames)"
