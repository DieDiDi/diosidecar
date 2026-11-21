#!/bin/zsh
# Launch the local DioSidecar build on macOS.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"
unset ELECTRON_RUN_AS_NODE
exec npm start
