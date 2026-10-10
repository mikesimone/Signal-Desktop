# signal-headless

Signal Desktop from this fork (with the external client bridge) running in
Docker on a virtual display, with the [signal-rambox](../signal-rambox)
helper serving its chat page. It is a normal linked device on your account,
so everything works as in Signal Desktop: messages you send reach your other
devices, read state syncs both ways, and mute and archive settings come
across. Nothing here is part of the upstream PR.

## Pieces

- `Dockerfile`: builds Signal from this repository (`build:release --linux
dir`) and a slim runtime image with Xvfb. Signal runs with
  `--password-store=basic` because there is no desktop keyring, and with
  `--no-sandbox` because Chromium's sandbox can't create its namespaces
  under Docker's default seccomp profile. That was a deliberate choice;
  the container, its loopback-only ports and the token page are the
  boundary instead.
- `patches/0001-enable-bridge-from-env.patch`: lets
  `SIGNAL_ENABLE_EXTERNAL_CLIENTS=1` turn the bridge on in a packaged build.
  Upstream only allows that in development builds, and Signal's remote
  config has not enabled the feature.
- `entrypoint.sh`: starts Xvfb, Signal and the helper (on the Node copied
  from the build stage).
- `screen.sh`: screenshots, clicks and VNC for the one-time setup.
- `compose.yml`: publishes the chat page and VNC on the host's 127.0.0.1
  only. Put a reverse proxy with HTTPS in front of 8083 and set
  `RAMBOX_ORIGIN` to its address.

## First run

1. Create `.env` next to `compose.yml` (see the comment in it), with the
   data folder owned by `SIGNAL_UID`.
2. `docker compose up -d --build` (the build takes a while).
3. Link it: `docker compose exec signal-desktop screen.sh qr` prints the
   link QR code as text to scan from your phone (Settings > Linked devices),
   or `screen.sh shot` saves a screenshot: copy
   `/data/screen.png` (in the data folder) somewhere you can see it, and scan
   the QR code from your phone (Settings > Linked devices). Name the device
   when asked: `screen.sh shot` again to see the screen, `screen.sh click X Y`
   and `screen.sh key` to answer. `screen.sh vnc` gives a live view instead.
4. The helper asks Signal for approval; Signal shows a dialog. Approve it the
   same way.
5. Get the Rambox URL: `docker compose exec signal-desktop screen.sh url`.

## Keeping it current

Signal Desktop builds stop working about 90 days after they are built, and
the servers eventually refuse old versions. Rebase this fork onto each
Signal release, run the "Signal headless image" workflow, then on the host
`git pull && docker compose up -d --build`. The profile lives in the data
folder, so rebuilding keeps the link and the approval.
