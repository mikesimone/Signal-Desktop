#!/bin/bash
# Copyright 2026 Mike Simone
# SPDX-License-Identifier: AGPL-3.0-only

# One-time setup helpers for the virtual display, run with docker exec:
#
#   screen.sh shot [file]     save a PNG of the screen (default /data/screen.png)
#   screen.sh click X Y       click at a screen position
#   screen.sh key KEYS        press keys, e.g. Return or ctrl+q
#   screen.sh vnc             serve the screen over VNC on port 5900, which
#                             compose.yml publishes on the host's 127.0.0.1
#                             only (ssh -L 5901:127.0.0.1:5901 to reach it)

set -euo pipefail
export DISPLAY=:99

case "${1:-}" in
  shot) import -window root "${2:-/data/screen.png}" && echo "${2:-/data/screen.png}" ;;
  click) xdotool mousemove "$2" "$3" click 1 ;;
  key) xdotool key "$2" ;;
  vnc) exec x11vnc -nopw -forever -shared -rfbport 5900 ;;
  *) sed -n '5,13p' "$0"; exit 2 ;;
esac
