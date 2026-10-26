#!/bin/bash
# launchd entrypoint: run the listener with Orca's bundled Electron in node mode (fallback: node on PATH).
D="${ORCA_NOTIFY_DIR:-$(cd "$(dirname "$0")" && pwd)}"; cd "$D" || exit 1
export ORCA_NOTIFY_DIR="$D"
E="${ORCA_APP:-/Applications/Orca.app}/Contents/MacOS/Orca"
unset NODE_OPTIONS
if [ -x "$E" ]; then ELECTRON_RUN_AS_NODE=1 exec "$E" "$D/listener.js"; fi
exec node "$D/listener.js"
