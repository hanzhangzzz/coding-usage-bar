#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

pack_dir="$work_dir/pack"
prefix_dir="$work_dir/prefix"
home_dir="$work_dir/home"
run_dir="$work_dir/run"
mkdir -p "$pack_dir" "$prefix_dir" "$home_dir" "$run_dir"

package_file="$(cd "$repo_root" && npm pack --pack-destination "$pack_dir" --silent)"
npm install --global --prefix "$prefix_dir" "$pack_dir/$package_file" --ignore-scripts

export HOME="$home_dir"
export CODING_USAGE_BAR_PLUGIN_DIR="$home_dir/swiftbar"
cli="$prefix_dir/bin/coding-usage-bar"

cd "$run_dir"
"$cli" --help | grep -q "Coding Usage Bar"
set +e
doctor_output="$("$cli" doctor --dry-run 2>&1)"
doctor_status=$?
set -e
if [[ $doctor_status -ne 0 && $doctor_status -ne 1 ]]; then
  printf '%s\n' "$doctor_output" >&2
  exit "$doctor_status"
fi
printf '%s\n' "$doctor_output" | grep -q "Runtime directory"
"$cli" status --fixtures | grep -qE '^Claude.*UNDER_BURN$'
"$cli" menubar render | grep -q "Coding Usage Bar"
