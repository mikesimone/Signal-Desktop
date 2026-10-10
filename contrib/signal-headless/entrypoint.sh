#!/bin/bash
# Copyright 2026 Mike Simone
# SPDX-License-Identifier: AGPL-3.0-only

# Starts the virtual display, Signal and the signal-rambox helper. If any of
# them exits, the container exits and Docker restarts it.
#
# RAMBOX_ORIGIN: the HTTPS address Rambox uses (e.g. https://sigdesktop.example)
# SIGNAL_EXTRA_ARGS: extra Signal command-line flags, if ever needed

set -euo pipefail

USER_DATA="$HOME/.config/Signal"
mkdir -p "$USER_DATA" "$HOME/signal-rambox"

# A stale lock from an unclean stop would keep Xvfb from starting.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &

for _ in $(seq 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

# --password-store=basic: no desktop keyring in here; the database key is
# kept in the profile, which only this container's volume holds.
# --no-sandbox: Mike's choice (2026-10-10). Chromium's sandbox can't create
# its namespaces under Docker's default seccomp profile and capabilities.
/opt/Signal/signal-desktop --password-store=basic --no-sandbox \
  ${SIGNAL_EXTRA_ARGS:-} &

helper_args=(--user-data "$USER_DATA" --config "$HOME/signal-rambox"
  --bind 0.0.0.0 --port 8083)
if [ -n "${RAMBOX_ORIGIN:-}" ]; then
  helper_args+=(--origin "$RAMBOX_ORIGIN")
fi
node /opt/signal-rambox/signal-rambox.mjs "${helper_args[@]}" &

wait -n
exit 1
