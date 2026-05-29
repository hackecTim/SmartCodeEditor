#!/bin/bash
set -e
echo "=== SmartCode LSP Bridge ==="
mkdir -p /workspace /workspace/java-data /target-root /var/log/lsyncd
# Začetna sinhronizacija target-root → workspace
if [ "$(ls -A /target-root 2>/dev/null)" ]; then
  echo "Initial sync: target-root → workspace..."
  rsync -a --include="*.java" --include="*.jar" --include="*.c" \
           --include="*.cpp" --include="*.cc" --include="*.cxx" \
           --include="*.h" --include="*.hpp" --include="*/" \
           --exclude="*" --prune-empty-dirs \
           /target-root/ /workspace/
  echo "Initial sync done."
fi

# CMake za clangd
if [ -f /workspace/CMakeLists.txt ]; then
  echo "Running cmake..."
  cmake -S /workspace -B /workspace/build \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=1 \
    -DCMAKE_BUILD_TYPE=Debug 2>&1 || true
fi

echo "lsyncd is controlled by editor options through /sync-root."

echo "Starting server..."
exec node /app/server.js