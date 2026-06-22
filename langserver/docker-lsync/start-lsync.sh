#!/usr/bin/env bash
set -euo pipefail

SOURCE="${LSYNC_SOURCE:-/algator_projects}"
TARGET="${LSYNC_TARGET:-/algator_lsync_root}"
POLL_INTERVAL="${LSYNC_POLL_INTERVAL:-2}"
VERBOSE="${LSYNC_VERBOSE:-0}"

mkdir -p "$TARGET" /var/log/lsyncd

echo "=== SmartCode lsync ==="
echo "Source (<algator_projects>): $SOURCE"
echo "Target (<algator_lsync_root>): $TARGET"
echo "Allowed files: *.java, *.c, *.cpp, *.cc, *.cxx, *.h, *.hpp, *.jar, .classpath, .project, .settings, pom.xml, build.gradle"
echo "Protected generated Java metadata in target: .classpath, .project, .settings, bin"
echo "Polling interval: ${POLL_INTERVAL}s"

if [ ! -d "$SOURCE" ]; then
  echo "ERROR: source folder does not exist: $SOURCE"
  exit 1
fi

sync_once() {
  if [ "$VERBOSE" = "1" ]; then
    rsync -a --delete --itemize-changes \
      --filter='P .classpath' \
      --filter='P .project' \
      --filter='P .settings/***' \
      --filter='P bin/***' \
      --include='*/' \
      --include='*.java' \
      --include='*.c' \
      --include='*.cpp' \
      --include='*.cc' \
      --include='*.cxx' \
      --include='*.h' \
      --include='*.hpp' \
      --include='*.jar' \
      --include='.classpath' \
      --include='.project' \
      --include='.settings/' \
      --include='.settings/**' \
      --include='pom.xml' \
      --include='build.gradle' \
      --include='build.gradle.kts' \
      --exclude='*' \
      --prune-empty-dirs \
      "$SOURCE/" "$TARGET/"
  else
    rsync -a --delete \
      --filter='P .classpath' \
      --filter='P .project' \
      --filter='P .settings/***' \
      --filter='P bin/***' \
      --include='*/' \
      --include='*.java' \
      --include='*.c' \
      --include='*.cpp' \
      --include='*.cc' \
      --include='*.cxx' \
      --include='*.h' \
      --include='*.hpp' \
      --include='*.jar' \
      --include='.classpath' \
      --include='.project' \
      --include='.settings/' \
      --include='.settings/**' \
      --include='pom.xml' \
      --include='build.gradle' \
      --include='build.gradle.kts' \
      --exclude='*' \
      --prune-empty-dirs \
      "$SOURCE/" "$TARGET/"
  fi
}

echo "Running initial sync..."
sync_once
echo "Initial sync completed."

if [ "$POLL_INTERVAL" != "0" ]; then
  echo "Starting fallback polling sync every ${POLL_INTERVAL}s..."
  while true; do
    sleep "$POLL_INTERVAL"
    sync_once
  done &
else
  echo "Fallback polling sync disabled."
fi

echo "Starting lsyncd watcher..."
exec lsyncd -nodaemon /etc/lsyncd.conf.lua
