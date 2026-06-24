#!/usr/bin/env bash
set -euo pipefail

SOURCE="${LSYNC_SOURCE:-/algator_projects}"
TARGET="${LSYNC_TARGET:-/algator_lsync_root}"
POLL_INTERVAL="${LSYNC_POLL_INTERVAL:-1}"
VERBOSE="${LSYNC_VERBOSE:-0}"

mkdir -p "$SOURCE" "$TARGET" /var/log/lsyncd

cat <<INFO
=== SmartCode lsync ===
  Source (<algator_root>):        $SOURCE
  Target (<algator_lsync_root>):  $TARGET
  Direction:                      source -> target
  Polling interval:               ${POLL_INTERVAL}s
INFO

if [ ! -d "$SOURCE" ]; then
  echo "ERROR: source folder does not exist: $SOURCE"
  exit 1
fi

# Varnost: izvorna in ciljna mapa ne smeta biti ista mapa.
# To prepreči primer, kjer uporabnik isto Windows mapo pripne kot /algator_projects in /algator_lsync_root.
SOURCE_ID="$(stat -c '%d:%i' "$SOURCE" 2>/dev/null || true)"
TARGET_ID="$(stat -c '%d:%i' "$TARGET" 2>/dev/null || true)"
if [ -n "$SOURCE_ID" ] && [ "$SOURCE_ID" = "$TARGET_ID" ]; then
  echo "ERROR: /algator_projects and /algator_lsync_root point to the same directory."
  echo "Use two different mounts, or use a Docker named volume for /algator_lsync_root."
  echo "Correct example:"
  echo "  -v \"D:\\ALGATOR_ROOT\\data_root\\projects:/algator_projects:ro\" -v \"smartcode-lsync-root:/algator_lsync_root\""
  exit 1
fi

sync_once() {
  local args=(
    -a
    --delete
    --filter='P .classpath'
    --filter='P .project'
    --filter='P .settings/***'
    --filter='P bin/***'
    --include='*/'
    --include='*.java'
    --include='*.c'
    --include='*.cpp'
    --include='*.cc'
    --include='*.cxx'
    --include='*.h'
    --include='*.hpp'
    --include='*.jar'
    --include='.classpath'
    --include='.project'
    --include='.settings/'
    --include='.settings/**'
    --include='pom.xml'
    --include='build.gradle'
    --include='build.gradle.kts'
    --include='CMakeLists.txt'
    --include='compile_commands.json'
    --exclude='*'
    --prune-empty-dirs
  )

  if [ "$VERBOSE" = "1" ]; then
    rsync "${args[@]}" --itemize-changes "$SOURCE/" "$TARGET/"
  else
    rsync "${args[@]}" "$SOURCE/" "$TARGET/"
  fi
}

echo "[lsync] Initial sync..."
sync_once
echo "[lsync] Initial sync completed."

if [ "$POLL_INTERVAL" != "0" ]; then
  echo "[lsync] Starting fallback polling sync every ${POLL_INTERVAL}s..."
  while true; do
    sleep "$POLL_INTERVAL"
    sync_once
  done &
else
  echo "[lsync] Fallback polling sync disabled."
fi

echo "[lsync] Starting lsyncd watcher..."
exec lsyncd -nodaemon /etc/lsyncd.conf.lua
