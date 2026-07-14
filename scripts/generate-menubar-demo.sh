#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_IMAGE="$ROOT_DIR/assets/screenshot-20260714-160548.png"
OUTPUT_GIF="$ROOT_DIR/docs/assets/demo.gif"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coding-usage-bar-demo.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

WIDTH=800
HEIGHT=1068
MENU_HEIGHT=37
PANEL_HEIGHT=$((HEIGHT - MENU_HEIGHT))
FRAME=0

frame_path() {
  printf '%s/frame-%03d.png' "$WORK_DIR" "$1"
}

append_collapsed_frame() {
  local cursor_x="$1"
  local cursor_y="$2"
  local ring_radius="$3"
  render_cursor "$WORK_DIR/base.png" "$(frame_path "$FRAME")" "$cursor_x" "$cursor_y" "$ring_radius"
  FRAME=$((FRAME + 1))
}

append_reveal_frame() {
  local reveal_height="$1"
  local cursor_x="$2"
  local cursor_y="$3"
  local ring_radius="$4"
  local output
  output="$(frame_path "$FRAME")"

  if ((reveal_height <= 0)); then
    cp "$WORK_DIR/base.png" "$WORK_DIR/composed.png"
  elif ((reveal_height >= PANEL_HEIGHT)); then
    cp "$WORK_DIR/open.png" "$WORK_DIR/composed.png"
  else
    magick "$WORK_DIR/open.png" \
      -crop "${WIDTH}x${reveal_height}+0+${MENU_HEIGHT}" +repage \
      "$WORK_DIR/panel.png"
    magick "$WORK_DIR/base.png" "$WORK_DIR/panel.png" \
      -geometry "+0+${MENU_HEIGHT}" -composite "$WORK_DIR/composed.png"
  fi

  render_cursor "$WORK_DIR/composed.png" "$output" "$cursor_x" "$cursor_y" "$ring_radius"
  FRAME=$((FRAME + 1))
}

render_cursor() {
  local source="$1"
  local output="$2"
  local x="$3"
  local y="$4"
  local ring_radius="$5"

  if ((ring_radius > 0)); then
    magick "$source" \
      -fill none \
      -stroke '#0A84FFAA' \
      -strokewidth 3 \
      -draw "circle ${x},${y} $((x + ring_radius)),${y}" \
      -fill white \
      -stroke '#111827' \
      -strokewidth 2 \
      -draw "path 'M ${x},${y} L ${x},$((y + 26)) L $((x + 7)),$((y + 19)) L $((x + 13)),$((y + 31)) L $((x + 19)),$((y + 28)) L $((x + 13)),$((y + 17)) L $((x + 24)),$((y + 17)) Z'" \
      "$output"
    return
  fi

  magick "$source" \
    -fill white \
    -stroke '#111827' \
    -strokewidth 2 \
    -draw "path 'M ${x},${y} L ${x},$((y + 26)) L $((x + 7)),$((y + 19)) L $((x + 13)),$((y + 31)) L $((x + 19)),$((y + 28)) L $((x + 13)),$((y + 17)) L $((x + 24)),$((y + 17)) Z'" \
    "$output"
}

command -v magick >/dev/null 2>&1 || {
  echo "ImageMagick is required: brew install imagemagick" >&2
  exit 1
}

test -f "$SOURCE_IMAGE" || {
  echo "Source screenshot not found: $SOURCE_IMAGE" >&2
  exit 1
}

magick "$SOURCE_IMAGE" -resize "${WIDTH}x${HEIGHT}!" "$WORK_DIR/open.png"
magick -size "${WIDTH}x${HEIGHT}" 'gradient:#F8FBFC-#E7F4F6' "$WORK_DIR/base.png"
magick "$WORK_DIR/open.png" -crop "${WIDTH}x${MENU_HEIGHT}+0+0" +repage "$WORK_DIR/menu.png"
magick "$WORK_DIR/base.png" "$WORK_DIR/menu.png" -geometry +0+0 -composite "$WORK_DIR/base-with-menu.png"
mv "$WORK_DIR/base-with-menu.png" "$WORK_DIR/base.png"

for step in {0..11}; do
  cursor_x=$((740 - 190 * step / 11))
  cursor_y=$((110 - 88 * step / 11))
  append_collapsed_frame "$cursor_x" "$cursor_y" 0
done

for ring_radius in 0 5 10 15 20 12; do
  append_collapsed_frame 550 22 "$ring_radius"
done

for step in {1..10}; do
  reveal_height=$((PANEL_HEIGHT * step * (20 - step) / 100))
  append_reveal_frame "$reveal_height" 550 22 0
done

for _ in {1..28}; do
  append_reveal_frame "$PANEL_HEIGHT" 550 22 0
done

for ring_radius in 0 5 10 15 20 12; do
  append_reveal_frame "$PANEL_HEIGHT" 550 22 "$ring_radius"
done

for step in {9..0}; do
  reveal_height=$((PANEL_HEIGHT * step * (20 - step) / 100))
  append_reveal_frame "$reveal_height" 550 22 0
done

for _ in {1..8}; do
  append_collapsed_frame 550 22 0
done

magick -delay 8 -loop 0 "$WORK_DIR"/frame-*.png -layers Optimize "$OUTPUT_GIF"
echo "Generated $OUTPUT_GIF ($FRAME frames)"
