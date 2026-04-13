#!/bin/bash
set -e
echo "=== SmartCode LSP Bridge ==="
mkdir -p /workspace /workspace/java-data

# Generate compile_commands.json for clangd
if [ -f /workspace/CMakeLists.txt ]; then
  echo "Running cmake..."
  cmake -S /workspace -B /workspace/build \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=1 \
    -DCMAKE_BUILD_TYPE=Debug 2>&1 || true
  [ -f /workspace/build/compile_commands.json ] \
    && echo "compile_commands.json ready" \
    || echo "Warning: compile_commands.json not generated"
else
  echo "No CMakeLists.txt - clangd will use fallback flags"
fi

echo "Starting server..."
exec node /app/server.js
