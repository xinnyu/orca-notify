#!/bin/bash
# usage: wake.sh <url> [keyFile]   (event JSON on stdin)
# POSTs the event to any webhook; sends "Authorization: Bearer <key>" if keyFile is non-empty.
set -euo pipefail
URL="${1:?url required}"; KEYFILE="${2:-}"; KEYFILE="${KEYFILE/#\~/$HOME}"
body=$(cat); [ -n "$body" ] || { echo "empty event" >&2; exit 1; }
post() { printf '%s' "$body" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$URL" \
  -H 'Content-Type: application/json' --data-binary @- "$@"; }
if [ -n "$KEYFILE" ]; then
  [ -s "$KEYFILE" ] || { echo "missing key file $KEYFILE" >&2; exit 2; }
  # header comes from a process substitution so the key never appears in argv / ps
  code=$(post -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$KEYFILE")"))
else
  code=$(post)
fi
echo "http $code"; [ "${code:0:1}" = 2 ]
