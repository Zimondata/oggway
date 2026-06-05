#!/bin/bash
#
# Run `qmd embed` for every group that has a QMD index.
#
# Designed to run OUTSIDE the agent sandbox (full network, filesystem, and
# Metal GPU access). The sandbox blocks `qmd embed` because node-llama-cpp
# needs to either talk to Metal or write a CPU build into a global
# node_modules dir — both are denied. Embedding off-sandbox keeps vectors
# fresh; the agent only ever runs `qmd query` / `qmd search`, which read
# the index produced here.

set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROUPS_DIR="$ROOT/groups"
QMD_BIN="${QMD_BIN:-qmd}"

if ! command -v "$QMD_BIN" >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] qmd-embed: '$QMD_BIN' not on PATH" >&2
  exit 1
fi

if [ ! -d "$GROUPS_DIR" ]; then
  echo "[$(date -u +%FT%TZ)] qmd-embed: no groups dir at $GROUPS_DIR" >&2
  exit 0
fi

shopt -s nullglob
status=0
for group_dir in "$GROUPS_DIR"/*/; do
  group_dir="${group_dir%/}"
  group_name="$(basename "$group_dir")"

  if [ ! -d "$group_dir/.qmd-data/qmd" ]; then
    continue
  fi

  echo "[$(date -u +%FT%TZ)] qmd-embed: $group_name"
  if ! (
    cd "$group_dir" && \
    XDG_CONFIG_HOME="$PWD/.qmd-config" \
    XDG_DATA_HOME="$PWD/.qmd-data" \
    XDG_CACHE_HOME="$PWD/.qmd-cache" \
    "$QMD_BIN" embed
  ); then
    echo "[$(date -u +%FT%TZ)] qmd-embed: FAILED for $group_name" >&2
    status=1
  fi
done

exit "$status"
