# Backchannel

_Signal for people who actually have friends._

> **Setting it up? Use [github.com/mikesimone/backchannel](https://github.com/mikesimone/backchannel).**
> It builds a tested release of this folder, and it's where issues go.
> This folder is the source, for building from the fork's main branch.

Your Signal chats in a browser tab (Rambox, Ferdium, or any browser),
served from a container on your own server. The container runs Signal
Desktop built from this fork on a virtual display, linked to your phone as
one more device, plus the [Backchannel helper](helper) that serves the chat
page. Everything works as in Signal Desktop: messages you send reach your
other devices, read state syncs both ways, and mute and archive settings
come across. What the page does compared to Signal Desktop:
[helper/PARITY.md](helper/PARITY.md).

Backchannel is not made, endorsed or supported by Signal Messenger.
"Signal" is their trademark and is used here only to say what this works
with. No prebuilt image is published: you build it from this repository,
which builds Signal Desktop from source on your machine. It needs nothing
else from you (no signal-cli or REST API).

If Backchannel is useful to you, you can leave a tip at
[ko-fi.com/gcbapps](https://ko-fi.com/gcbapps).

## Beyond Signal Desktop

A running list of things Signal Desktop doesn't do, or limits, that
Backchannel does. Each new one is added here when it ships.

- **Any browser tab.** Signal runs on your server, always online, and you
  use it from a tab in Rambox, Ferdium or any browser. No Signal Desktop
  window on your PC.
- **Notifications from the tab.** While the page is open, notifications
  come from it, not from a second Signal window.
- **Forward to any number of chats.** Signal forwards to at most five;
  Backchannel lists every chat, most recent first, with no limit.
- **One poll to many chats.** Signal can't forward a poll; Backchannel
  sends each chat its own copy.
- **Reply privately** to someone in a group: their message is quoted in
  your 1:1 chat, and the two are linked both ways on the page. Signal
  Desktop has no such option.
- **Sticker replies.** Signal has them built in but switched off;
  Backchannel sends a sticker as a reply. Recipients see the quote once
  their Signal app shows sticker replies.
- **Bold italic in one step**, from the format menu or bar. Signal needs
  two.
- **Scheduled messages.** Signal Desktop has none. Backchannel sends them
  from your server at the time you pick, even with your PC off.
- **Pick each chat's photo.** Signal shows either your phone's contact
  photos or people's Signal profile photos, for every chat at once.
  Backchannel lets you pick per chat, in its details.
- **Edit and tag when forwarding.** Signal lets you edit a forward's text;
  Backchannel also lets you @mention people. Each chat gets a real tag
  where that person is in the group, and plain "@Name" text elsewhere.
- **Markdown shortcuts and SMS-ready copies.** Type \*bold\*,
  \_italic\_, \_\*bold italic\*\_, \~strikethrough\~ or \`monospace\` and the
  style applies as you type (Backspace right after undoes it), or as you
  paste text that has them. Copying
  styled text puts Unicode bold, italic and strikethrough letters on the
  clipboard, so the styles survive a paste into an SMS or anywhere else,
  and pasting such text into Backchannel turns it back into Signal's styles.

## Quick start

You need an x86-64 Linux host with Docker and Compose (ARM hosts such as a
Raspberry Pi or an Apple Silicon Mac are untested), several GB of free disk
for the build, and your phone with Signal on it.

1. Get the code and make a data folder:

   ```sh
   git clone https://github.com/mikesimone/Signal-Desktop.git
   cd Signal-Desktop/contrib/backchannel
   sudo mkdir -p /var/lib/backchannel
   sudo chown 1000:1000 /var/lib/backchannel
   ```

2. Create `.env` next to `compose.yml`:

   ```sh
   BACKCHANNEL_UID=1000
   BACKCHANNEL_DATA=/var/lib/backchannel
   # Once it's behind your reverse proxy:
   # BACKCHANNEL_ORIGIN=https://chat.example.net
   ```

   The data folder holds your Signal profile and keys; keep it private
   and back it up.

3. Build and start it: `docker compose up -d --build`. The first build
   takes a while (about 20 minutes on a small server).

4. Link it to your phone. `docker compose exec backchannel screen.sh qr`
   prints the link QR code as text in your terminal. In Signal on your
   phone go to Settings > Linked devices > Link new device and scan it.
   Signal Desktop then asks for a device name: see the screen with
   `screen.sh shot` (it saves `screen.png` in the data folder), and answer
   with `screen.sh type 'My server'` and `screen.sh key Return`, or use
   `screen.sh vnc` for a live view (below).

5. Approve the helper. Signal shows a dialog asking to allow "Backchannel";
   allow it the same way (`screen.sh shot`, then `screen.sh click X Y`).

6. Open the page. `docker compose exec backchannel screen.sh url` prints
   its address, with a secret token in it. Anyone with that address can
   read and send your messages, so treat it like a password.

### Reaching the page

The container publishes the page (8083) and VNC (5901) on the host's
127.0.0.1 only. To use it from other machines, put a reverse proxy with
HTTPS in front of 8083 and set `BACKCHANNEL_ORIGIN` to its address. Let
the proxy pass large uploads, or photos over its default limit fail with
HTTP 413: in nginx, `client_max_body_size 100m;` in that server block. For
VNC from another machine: `ssh -L 5901:127.0.0.1:5901 yourserver`, then a
VNC viewer on `localhost:5901` after `screen.sh vnc`.

In Rambox: **Add app > Add Custom App**, paste the address, and turn on
notifications and "Display in tab" for the unread badge.

### On Windows (Docker Desktop)

Untested so far, but nothing in it is Linux-host specific: Docker Desktop
runs the same x86-64 Linux container inside WSL 2.

1. Install Docker Desktop (WSL 2 backend, its default) and a WSL
   distribution such as Ubuntu (`wsl --install -d Ubuntu` in PowerShell).
   In Docker Desktop, Settings > Resources > WSL integration, turn it on
   for that distribution.
2. Do the quick start inside the WSL shell (`wsl`), not in PowerShell, and
   keep both the clone and the data folder in the WSL file system (for
   example `~/Signal-Desktop` and `~/backchannel-data`, with
   `BACKCHANNEL_DATA=/home/you/backchannel-data` and `BACKCHANNEL_UID`
   set to the output of `id -u`). A folder on `C:` (`/mnt/c/...`) is much
   slower for the build and can't keep the Unix permissions Signal's
   profile needs.
3. Docker Desktop forwards the container's 127.0.0.1 ports to Windows, so
   on that PC the address from `screen.sh url` opens in any browser or in
   Rambox as is. VNC is at `localhost:5901` after `screen.sh vnc`.

It is only online while that PC is awake and Docker Desktop is running;
messages still reach your phone, and it catches up when it comes back, as
Signal Desktop does.

Give WSL enough memory for the build (`.wslconfig`, `memory=8GB` or more,
if the build is killed).

### Removing it

On your phone, Settings > Linked devices: unlink the device. Then
`docker compose down`, delete the data folder (it holds the Signal
profile and keys) and, if you like, `docker image rm backchannel`.

## Pieces

- `Dockerfile`: builds Signal Desktop from this repository
  (`build:release --linux dir`) and a slim runtime image with Xvfb. Signal
  runs with `--password-store=basic` because there is no desktop keyring,
  and with `--no-sandbox` because Chromium's sandbox can't create its
  namespaces under Docker's default seccomp profile. The container, its
  loopback-only ports and the token page are the boundary instead.
- `patches/0001-enable-bridge-from-env.patch`: lets
  `SIGNAL_ENABLE_EXTERNAL_CLIENTS=1` turn the bridge on in a packaged build.
- `entrypoint.sh`: starts Xvfb, Signal and the helper (on the Node copied
  from the build stage).
- `screen.sh`: screenshots, clicks and VNC for the one-time setup.
- `compose.yml`: the service, its ports on 127.0.0.1 only, and the data
  folder.
- `helper/`: the Backchannel helper and chat page. It also runs on its own
  next to Signal Desktop (this fork's build) on a PC: see its README.

### Upgrading from signal-headless

Before the rename this folder was `contrib/signal-headless`, with the helper
in `contrib/signal-rambox`. To move an existing install without relinking:

1. In the old folder: `docker compose down`.
2. `git pull`, then move your `.env` to `contrib/backchannel/` (the old
   names `SIGNAL_UID`, `SIGNAL_DATA` and `RAMBOX_ORIGIN` still work).
3. In `contrib/backchannel`: `docker compose up -d --build`.

The helper moves its `signal-rambox` folder in the data folder to
`backchannel` on first start, so the page address and Signal's approval
stay the same. Don't run the old and new containers at once: they would
share one Signal profile.

## Keeping it current

Signal Desktop builds stop working about 90 days after they are built, and
the servers eventually refuse old versions. Rebase this fork onto each
Signal release, run the "Backchannel image" workflow, then on the host
`git pull && docker compose up -d --build`. The profile lives in the data
folder, so rebuilding keeps the link and the approval.

## Hourly upstream sync (optional)

`sync/` merges new Signal Desktop commits into your fork every hour and
redeploys, using one unattended [Claude Code](https://claude.com/claude-code)
run (`claude -p` with a narrow tool allowlist) to resolve the merge, adapt
this folder, rebuild, check health and push. It rolls back to the previous
image if the new one doesn't come up, and never prints the page's token.

1. `sudo install -m 755 sync/sigdesktop-sync.sh /usr/local/bin/sigdesktop-sync`
2. Copy `sync/sigdesktop-sync.env.example` to `/etc/sigdesktop-sync.env`
   and fill it in. `SYNC_NOTIFY` can name any command that takes the report
   as its one argument.
3. Edit the user and paths in `sync/sigdesktop-sync.service`, copy it and
   `sync/sigdesktop-sync.timer` to `/etc/systemd/system/`, then
   `sudo systemctl enable --now sigdesktop-sync.timer`.

The first run only records where upstream is. The sync user needs `git`
push access to your fork, `gh` signed in, Docker, and Claude Code signed in.
