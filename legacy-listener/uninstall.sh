#!/bin/bash
# uninstall.sh [--label LABEL] — unloads the LaunchAgent. Leaves ~/.orca-notify (secrets/state) for you to delete.
set -euo pipefail
LABEL="dev.orca-notify"; [ "${1:-}" = --label ] && LABEL="$2"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/.local/bin/orca-notify"
echo "Unloaded $LABEL. Remove ~/.orca-notify manually if you no longer need it."
