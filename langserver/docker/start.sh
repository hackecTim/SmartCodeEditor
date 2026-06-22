#!/bin/bash
set -e

echo "=== SmartCode LSP ==="
echo "  LSYNC_ROOT:     ${LSYNC_ROOT:-/algator_lsync_root}"
echo "  WORKSPACE_ROOT: ${WORKSPACE_ROOT:-/workspace}"
echo "  PROJECT_FOLDER: ${PROJECT_FOLDER:-}"

mkdir -p "${LSYNC_ROOT:-/algator_lsync_root}" "${WORKSPACE_ROOT:-/workspace}" /tmp/jdtls-data

# CMake za clangd (če obstaja CMakeLists.txt v <algator_lsync_root>)
ROOT="${LSYNC_ROOT:-/algator_lsync_root}"
if [ -f "$ROOT/CMakeLists.txt" ]; then
  echo "Running cmake..."
  cmake -S "$ROOT" -B "$ROOT/build" \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=1 \
    -DCMAKE_BUILD_TYPE=Debug 2>&1 || true
fi

echo "Starting LSP server..."
exec node /app/server.js
