# Copyright 2026 Mike Simone
# SPDX-License-Identifier: AGPL-3.0-only

# Signal Desktop (this fork, with the external client bridge) running
# headless on a virtual display, plus the signal-rambox helper that serves
# its chat page. Build from the repository root:
#
#   docker build -f contrib/signal-headless/Dockerfile -t signal-headless .
#
# See contrib/signal-headless/README.md.

FROM node:24.21.0-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ patch libpulse0 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .

# The pnpm version Signal pins (devEngines; corepack does not read it).
RUN npm install -g "pnpm@$(node -p "require('./package.json').devEngines.packageManager.version")"

# Fork-only changes the upstream PR does not carry.
RUN for p in contrib/signal-headless/patches/*.patch; do patch -p1 < "$p"; done

RUN pnpm install --frozen-lockfile
# The build's 90-day expiry counts from SOURCE_DATE_EPOCH, which upstream
# takes from git; the image has no .git, so count from the build instead.
RUN SOURCE_DATE_EPOCH="$(date +%s)" pnpm run generate
RUN pnpm run build:release --linux dir --publish=never

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates tini xvfb xauth x11vnc xdotool imagemagick zbar-tools qrencode \
    libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 \
    libatk-bridge2.0-0 libcups2 libx11-xcb1 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libpango-1.0-0 libnotify4 libpulse0 libsecret-1-0 \
    fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Match the owner of the data volume on the host (see compose.yml).
ARG SIGNAL_UID=1000
RUN useradd --uid "$SIGNAL_UID" --create-home --home-dir /data signal

COPY --from=build /src/release/linux-unpacked /opt/Signal
# Node for the helper. Electron's own Node mode (ELECTRON_RUN_AS_NODE)
# crashed with SIGTRAP in the container.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# Chromium's setuid sandbox helper, as the .deb's postinst sets it up.
RUN chown root:root /opt/Signal/chrome-sandbox \
  && chmod 4755 /opt/Signal/chrome-sandbox

COPY contrib/signal-rambox/bridge.mjs contrib/signal-rambox/server.mjs \
  contrib/signal-rambox/store.mjs contrib/signal-rambox/signal-rambox.mjs \
  /opt/signal-rambox/
COPY contrib/signal-rambox/public /opt/signal-rambox/public
COPY contrib/signal-headless/entrypoint.sh contrib/signal-headless/screen.sh \
  /usr/local/bin/

USER signal
ENV HOME=/data \
  DISPLAY=:99 \
  SIGNAL_ENABLE_EXTERNAL_CLIENTS=1
VOLUME /data
EXPOSE 8083 5900

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
