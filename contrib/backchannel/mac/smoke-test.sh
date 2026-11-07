#!/bin/bash
# Copyright 2026 Brian Reed
# SPDX-License-Identifier: AGPL-3.0-only

# Starts a packaged Backchannel.app and checks that its helper serves the page
# on 127.0.0.1 behind the token: 404 without it, 200 with it, 421 for another
# Host. No Signal account needs to be linked. Used by release.sh and
# .github/workflows/mac.yml.
#
#   contrib/backchannel/mac/smoke-test.sh [path/to/Backchannel.app]

set -euo pipefail

app="${1:-release/mac-arm64/Backchannel.app}"
token_file="$HOME/Library/Application Support/Backchannel/backchannel/token"

if pgrep -xq Backchannel; then
  echo "Backchannel is already running; quit it first" >&2
  exit 1
fi

listening() {
  # lsof exits 1 when nothing listens.
  { lsof -nP -iTCP:47830-47839 -sTCP:LISTEN 2>/dev/null || true; } |
    awk 'NR > 1 { sub(/.*:/, "", $9); print $9 }' | sort -u
}

# The helper takes the first free port from 47830 to 47839.
before="$(listening)"
log="$(mktemp -t backchannel-smoke)"
"$app/Contents/MacOS/Backchannel" > "$log" 2>&1 &
pid=$!

port=''
for _ in $(seq 60); do
  port="$(comm -13 <(echo "$before") <(listening) | head -n 1)"
  if [ -n "$port" ] && [ -f "$token_file" ]; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 2
done

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@" || true
}

if [ -n "$port" ]; then
  base="http://127.0.0.1:$port"
  token="$(cat "$token_file")"
  bare="$(status "$base/")"
  page="$(status "$base/$token/")"
  foreign="$(status -H 'Host: example.com' "$base/$token/")"
else
  bare=none page=none foreign=none
fi

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

echo "helper port: ${port:-none}; no token: $bare; with token: $page; other Host: $foreign"
if [ "$bare" != 404 ] || [ "$page" != 200 ] || [ "$foreign" != 421 ]; then
  grep -iE 'backchannel|error' "$log" | tail -n 20 || true
  echo "The helper didn't serve the page as expected (log: $log)" >&2
  exit 1
fi
rm -f "$log"
