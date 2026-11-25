#!/bin/bash
# Copyright 2026 Brian Reed
# SPDX-License-Identifier: AGPL-3.0-only

# Builds Backchannel for Mac (Apple Silicon) from this checkout.
#
#   contrib/backchannel/mac/build.sh          # release/mac-arm64/Backchannel.app
#   contrib/backchannel/mac/build.sh dmg zip  # installers, as M3 will publish
#
# Run `pnpm install` first, with the Node and pnpm versions in BUILD-NOTES.md
# first on PATH. Without SIGN_MACOS_SCRIPT the app is ad-hoc signed, which
# runs on this Mac but not on others.

set -euo pipefail

cd "$(dirname "$0")/../../.."

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(dir)
fi

export SIGNAL_ENV=production

pnpm run generate

# local-production.json is generated, git-ignored and packaged in app.asar.
# - updatesEnabled: Signal's updater installs only Signal-signed builds from
#   Signal's server, so it's off and Homebrew or a new DMG brings updates
#   (CLAUDE.md rule 5).
# - backchannelApp: turns the bridge on and starts the helper and the
#   Backchannel window (ts/backchannel/).
node -e '
  const fs = require("node:fs");
  const file = "config/local-production.json";
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.updatesEnabled = false;
  config.backchannelApp = true;
  fs.writeFileSync(file, JSON.stringify(config));
'

if [ -z "${SIGN_MACOS_SCRIPT:-}" ]; then
  export SKIP_SIGNING_SCRIPT=1
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

NODE_OPTIONS='--import=tsx' pnpm exec electron-builder \
  --config contrib/backchannel/mac/electron-builder.config.mjs \
  --mac "${targets[@]}" --arm64

app=release/mac-arm64/Backchannel.app
if [ -z "${SIGN_MACOS_SCRIPT:-}" ] && [ -d "$app" ]; then
  # Electron ships with only a linker signature, which doesn't seal the
  # bundle; an ad-hoc signature makes `codesign --verify` pass.
  codesign --force --deep --sign - "$app"
fi
