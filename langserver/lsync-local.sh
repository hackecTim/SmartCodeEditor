#!/bin/bash
# ── Lokalni lsync (brez Dockerja) ──
# Kopira programske datoteke iz algator_projects v algator_lsync_root.
# Zahteva: rsync (in opcijsko inotifywait za Linux, ali polling na Mac/Win)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

SOURCE="$ROOT_DIR/algator_projects"
TARGET="$ROOT_DIR/algator_lsync_root"

mkdir -p "$SOURCE" "$TARGET"

RSYNC_ARGS=(
  -a --checksum --delete
  --include="*/"
  --include="*.java"
  --include="*.c"
  --include="*.cpp"
  --include="*.cc"
  --include="*.cxx"
  --include="*.h"
  --include="*.hpp"
  --include="*.jar"
  --exclude="*"
  --prune-empty-dirs
)

echo "=== SmartCode lsync (lokalno) ==="
echo "  algator_projects → algator_lsync_root"
echo "  Source: $SOURCE"
echo "  Target: $TARGET"
echo ""

# Začetna sinhronizacija
echo "[lsync] Začetna sinhronizacija..."
rsync "${RSYNC_ARGS[@]}" "$SOURCE/" "$TARGET/"
echo "[lsync] Začetna sinhronizacija OK"

# Opazovanje
if command -v inotifywait &>/dev/null; then
  echo "[lsync] Opazujem s inotifywait..."
  while inotifywait -r -e modify,create,delete,move "$SOURCE" -q; do
    rsync "${RSYNC_ARGS[@]}" "$SOURCE/" "$TARGET/"
    echo "[lsync] Sinhronizacija $(date '+%H:%M:%S')"
  done
else
  # Polling (Mac/Windows WSL)
  echo "[lsync] inotifywait ni na voljo — polling vsakih 2s..."
  LAST=""
  while true; do
    CURRENT=$(find "$SOURCE" \( -name "*.java" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.jar" \) -newer "$TARGET" 2>/dev/null | head -1)
    if [ -n "$CURRENT" ] || [ "$LAST" != "$(find "$SOURCE" -type f | sort | md5sum 2>/dev/null)" ]; then
      rsync "${RSYNC_ARGS[@]}" "$SOURCE/" "$TARGET/"
      echo "[lsync] Sinhronizacija $(date '+%H:%M:%S')"
      LAST="$(find "$SOURCE" -type f | sort | md5sum 2>/dev/null)"
    fi
    sleep 2
  done
fi
