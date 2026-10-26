#!/bin/bash
# install.sh [--dir DIR] [--label LABEL] [--bin BINDIR] [--no-launchd]
# Copies orca-notify into DIR (default ~/.orca-notify), writes a LaunchAgent and loads it.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.orca-notify"; LABEL="dev.orca-notify"; BIN="$HOME/.local/bin"; LOAD=1
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --label) LABEL="$2"; shift 2;; --bin) BIN="$2"; shift 2;;
  --no-launchd) LOAD=0; shift;; -h|--help) sed -n '2,3p' "$0"; exit 0;; *) echo "unknown $1"; exit 2;; esac; done
[ "$(uname)" = Darwin ] || { echo "macOS only"; exit 1; }
[ -d /Applications/Orca.app ] || echo "warning: /Applications/Orca.app not found (set ORCA_APP)"
mkdir -p "$DIR" "$BIN"; chmod 700 "$DIR"
for f in listener.js pair.js run.sh wake.sh orca-notify; do cp "$SRC/$f" "$DIR/$f"; done
chmod +x "$DIR/run.sh" "$DIR/wake.sh" "$DIR/orca-notify"
[ -f "$DIR/watch.json" ] || echo '{}' > "$DIR/watch.json"
[ -f "$DIR/routes.json" ] || echo '{"targets":{}}' > "$DIR/routes.json"
echo "$LABEL" > "$DIR/.label"
# wrapper so ORCA_NOTIFY_DIR follows the install dir
printf '#!/bin/bash\nexport ORCA_NOTIFY_DIR=%q\nexec %q "$@"\n' "$DIR" "$DIR/orca-notify" > "$BIN/orca-notify"; chmod +x "$BIN/orca-notify"
PL="$HOME/Library/LaunchAgents/$LABEL.plist"; mkdir -p "$(dirname "$PL")"
esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat > "$PL" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>$(esc "$LABEL")</string>
 <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(esc "$DIR/run.sh")</string></array>
 <key>RunAtLoad</key><true/>
 <key>KeepAlive</key><true/>
 <key>ThrottleInterval</key><integer>10</integer>
 <key>EnvironmentVariables</key><dict>
  <key>ORCA_NOTIFY_DIR</key><string>$(esc "$DIR")</string>
  <key>LANG</key><string>en_US.UTF-8</string>
  <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
 </dict>
 <key>StandardOutPath</key><string>$(esc "$DIR/listener.log")</string>
 <key>StandardErrorPath</key><string>$(esc "$DIR/listener.log")</string>
</dict></plist>
P
plutil -lint "$PL" >/dev/null
if [ $LOAD = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PL"
fi
echo "Installed to $DIR (CLI: $BIN/orca-notify, LaunchAgent: $PL)"
echo "Next: orca-notify pair; orca-notify target add <name> <url>; orca-notify watch add <pane> <label>"
