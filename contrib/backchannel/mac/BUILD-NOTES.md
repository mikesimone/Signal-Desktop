# BUILD-NOTES: Backchannel for Mac

How this fork was built for Apple Silicon, step by step, with what went
wrong. M0 builds it unmodified; later milestones add to this file.

## M0: unmodified build (2026-11-02)

Result: **works.** The unpackaged dev run starts, the bridge socket
appears, and the link QR code shows. An unsigned arm64 `Signal.app`
packages in about 15 seconds. It was not launched; see "Don't launch the
packaged app yet" below.

### Machine and versions

| What | Version |
|---|---|
| Mac | Apple Silicon (`arm64`) |
| macOS | 27.0.1 (26A434) |
| Xcode | 27.2 (27B52); Command Line Tools 27.0 (clang 21.0.0) |
| Python | 3.14.6 (system; used by node-gyp) |
| Node | 24.22.0 (from `.nvmrc` and `package.json` `engines`) |
| pnpm | 11.24.0 (from `package.json` `devEngines.packageManager`) |
| Electron | 45.0.0 |
| electron-builder | 26.11.1 |
| Fork | `mikesimone/Signal-Desktop` `main` at `c7715ee27` (Signal Desktop 8.36.0-alpha.1) |

### 1. Node and pnpm at the pinned versions

The Mac had Node 26.3.1, no pnpm and no version manager. Rather than
replace the system Node, install the pinned Node in its own folder and
put it first on `PATH` only for build shells:

```sh
V=24.22.0
T="$HOME/.local/toolchains"
mkdir -p "$T" && cd "$T"
curl -fsSLO "https://nodejs.org/dist/v$V/node-v$V-darwin-arm64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v$V/SHASUMS256.txt"
grep " node-v$V-darwin-arm64.tar.xz\$" SHASUMS256.txt | shasum -a 256 -c -
tar -xJf "node-v$V-darwin-arm64.tar.xz" && rm "node-v$V-darwin-arm64.tar.xz" SHASUMS256.txt

export PATH="$HOME/.local/toolchains/node-v24.22.0-darwin-arm64/bin:$PATH"
npm install -g pnpm@11.24.0   # lands in that Node's folder, not system-wide
node -v && pnpm -v            # v24.22.0, 11.24.0
```

`nvm install` (it reads `.nvmrc`) works just as well if you already use
nvm. Every command below assumes this `PATH`.

### 2. Clone

```sh
git clone --filter=blob:none https://github.com/mikesimone/Signal-Desktop.git
cd Signal-Desktop
```

A blobless clone (`--filter=blob:none`) saves most of the download and
still works for building, branching and pushing.

### 3. Install dependencies

```sh
pnpm install --frozen-lockfile   # about 45 s with a cold pnpm store
```

What showed up, none of it fatal:

- `Attempting to build a module with a space in the path`, four times,
  from `electron-builder install-app-deps`. This checkout lived under
  `~/Claude Code/...`. Every native module still built and the install
  finished. If a native build ever fails, try a path without spaces first.
- `The selected platform is no longer supported by libc++`, a warning
  from `packages/mute-state-change`. Harmless.
- `postinstall` regenerates `ACKNOWLEDGMENTS.md`, and on this fork it
  adds a section for `@signalapp/windows-local-pipe` (the fork's
  Windows named-pipe package). The checked-in file doesn't have it yet.
  Revert it (`git checkout -- ACKNOWLEDGMENTS.md`) or regenerate and
  commit it upstream in the fork.

### 4. Generate

```sh
pnpm run generate   # about 10 s
```

This writes `config/local-production.json` with the build's creation and
expiry times. Builds expire **90 days** after the fork's last commit
time (`scripts/get-expire-time.mjs`; versions that can't auto-update get
30 days). This build expires 2027-02-01.

### 5. Dev run with the bridge on

```sh
SIGNAL_ENABLE_EXTERNAL_CLIENTS=1 pnpm start
```

- Profile: `~/Library/Application Support/Signal-development`
  (`config/development.json` sets `storageProfile: development`), so it
  never touches official Signal Desktop's `~/Library/Application Support/Signal`.
- The upstream `#isEnabled` already honors the variable in unpackaged
  runs; patch 0001 isn't needed here.
- The log shows
  `[externalClientMain] start: listening on socket .../Signal-development/external-client/<hash>.sock`.
  The socket is mode `0600` in a `0700` folder, and it's removed on quit
  (`external client bridge stopped`).
- The window shows Signal's welcome screen. **Link your account** shows
  the link QR code. DevTools open by default in development.
- The updater logs `Updates disabled` in dev runs.

### 6. Package an unsigned arm64 app

`pnpm run build` is Signal's release build. It makes x64 and arm64 zips
plus a universal DMG, and it calls Signal's signing hook, which fails
without `SIGN_MACOS_SCRIPT`. For a local arm64 app with no signing:

```sh
SKIP_SIGNING_SCRIPT=1 CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm run build:release --mac dir --arm64
```

- `build:release` doesn't run `generate`; run step 4 first.
- Output: `release/mac-arm64/Signal.app`, 327 MB, `arm64` only,
  `CFBundleIdentifier` `org.whispersystems.signal-desktop`, minimum
  macOS 13.0.
- Notarization skips itself when `APPLE_USERNAME` is unset (it logs
  `appleId must be provided...`, which is expected here).
- The bundle carries only Electron's linker ad-hoc signature, so
  `codesign --verify --deep --strict` fails ("code has no resources but
  signature indicates they must be present"). An ad-hoc re-sign fixes
  that: `codesign --force --deep --sign - release/mac-arm64/Signal.app`.
  (`build.sh` now has electron-builder sign instead; see M3.)

### Don't launch Signal's own packaged build

The packaged app from step 6 still has Signal's name and app ID, and a
packaged build deliberately ignores `NODE_CONFIG` and the other config
variables (`app/config.main.ts`, "harden production config against the
local env"). So it would open `~/Library/Application Support/Signal`,
which is official Signal Desktop's real profile, and could migrate that
database to this build's schema. Build with
`contrib/backchannel/mac/build.sh` (M1, below) instead; that app has its
own profile.

### Facts for later milestones

- **Fuses** (`scripts/fuse-electron.mjs`, confirmed with
  `pnpm exec electron-fuses read --app release/mac-arm64/Signal.app`):
  `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on,
  `EnableEmbeddedAsarIntegrityValidation` on. For M2, the helper can't
  run as `ELECTRON_RUN_AS_NODE=1 Signal`; it has to be a `utilityProcess`
  (as planned), and its files have to ship inside the app's asar (or be
  loaded in a way the asar integrity check allows).
- **Icon:** the Mac icon is `build/icons/mac/AppIcon.icon` (Icon Composer
  format), not an `.icns`. M1 should make a Backchannel `.icon` the same
  way, or check that electron-builder 26 still accepts an `.icns`.
- **Updater:** production builds publish to and check
  `https://updates.signal.org/desktop` (`build.mac.publish`). M1 must
  repoint or disable it.
- **Minimum macOS:** Signal Desktop supports macOS 13
  (`LSMinimumSystemVersion` 13.0). CLAUDE.md's "macOS 14 or later" is a
  Backchannel choice, not a Signal requirement.
- **Helper tests:** `node --test contrib/backchannel/helper/test/backchannel_test.mjs`
  passes 67 of 67 on Node 24.22.0. Passing the folder
  (`node --test contrib/backchannel/helper/test/`) fails with
  `Cannot find module`.

## M1: its own app beside official Signal Desktop (2026-11-02)

Result: **works.** `Backchannel.app` and official `Signal.app` ran at the
same time on one Mac, each with its own database
(`lsof` showed `.../Application Support/Backchannel/sql/db.sqlite` and
`.../Application Support/Signal/sql/db.sqlite`) and its own keychain item
(`Backchannel Safe Storage` and `Signal Safe Storage`).

### Build

```sh
contrib/backchannel/mac/build.sh          # release/mac-arm64/Backchannel.app
contrib/backchannel/mac/build.sh dmg zip  # installers (see M3)
```

The script runs `generate`, turns the updater off and runs electron-builder
with `contrib/backchannel/mac/electron-builder.config.mjs`. (In M1 it
ad-hoc signed the app itself afterward; M3 moved signing into
electron-builder.) About 45 s with a warm cache.

### What makes it a separate app

| Setting | Value | Where |
|---|---|---|
| Bundle ID | `net.mikesimone.backchannel.mac` | `electron-builder.config.mjs` |
| Name | `Backchannel` (`productName`, `CFBundleName`, executable) | same |
| Data folder | `~/Library/Application Support/Backchannel` | follows `productName` through `extraMetadata` |
| Keychain | `Backchannel Safe Storage` | follows the name |
| Architecture | `arm64` only; minimum macOS 14.0 | same |
| Icon | `contrib/backchannel/mac/icon/AppIcon.icon` (Icon Composer; built into `Assets.car` and `icon.icns`) | same |
| Updater | off (`updatesEnabled: false` in the packaged `config/local-production.json`); `publish: null` | `build.sh` |
| About window | "Backchannel", plus "Based on Signal Desktop. Not made, endorsed or supported by Signal Messenger." | `ts/components/About.dom.tsx` |

The config file starts from Signal's `build` block in `package.json` and
overrides only these fields, so `package.json` stays untouched and upstream
changes to the build block still flow in.

Upstream files touched: **one**, `ts/components/About.dom.tsx`, marked
`// BACKCHANNEL:`.

### Still Signal-branded (later work)

- Menu items and window text come from Signal's strings: "About Signal
  Desktop", "Quit Signal", the "Signal" logo on the link screen and the
  About window. A strings overlay, like Android's `rebrand_strings.py`,
  is the likely fix.
- The DMG background and volume icon were Signal's. Replaced in M3.
- `scripts/notarize.mjs` reads the bundle ID from `package.json`, not the
  config file. M3 turns that hook off and uses electron-builder's own
  notarization.
- Both apps register `sgnl://` and `signalcaptcha://`, and Signal calls
  `setAsDefaultProtocolClient` at every start, so whichever app started
  last opens those links. Left as upstream on purpose (2026-11-02); revisit
  in M2.

### Notes

- `open` doesn't pass environment variables to the app, and packaged
  builds ignore `SIGNAL_ENABLE_EXTERNAL_CLIENTS` anyway (no patch 0001
  here). Turning the bridge on in the packaged app is M2.
- Don't run `asar extract-file` from the repo root: it writes the file to
  the current folder and overwrote `package.json` once. Extract into a
  scratch folder.

## M2: bridge on, helper inside, page in its own window (2026-11-02)

Result: **the plumbing works; the linked-account test is still to do.**
In both a dev run and the packaged app, with no environment variables, the
bridge turns on, the helper starts inside the app, connects, and reports
`unlinked`. The page and Signal's fonts are served from inside `app.asar`.
Quitting stops the helper and closes its port. The Backchannel window only
opens after linking and approval, so it hasn't been seen yet. That's the
real-account walkthrough below.

### How it fits together

```
Backchannel window ──http://127.0.0.1:<port>/<token>/──▶ helper ──socket──▶ bridge ──▶ Signal
(sandboxed, own session)                     (Electron utility process)
```

- **Build-time switch.** `build.sh` writes `"backchannelApp": true` into the
  packaged `config/local-production.json`. `ts/backchannel/config.main.ts`
  reads it, and `#isEnabled` in `ts/main/externalClientMain.main.ts`
  returns true for it. Signal's approval dialog is unchanged.
- **Helper.** `ts/backchannel/app.main.ts` runs
  `contrib/backchannel/helper/backchannel.mjs` with
  `utilityProcess.fork`, using the container's flags except
  `--bind 127.0.0.1` and `--config <profile>/backchannel`. It uses port 47830,
  or the next free one up to 47839. The helper's output goes to Signal's log
  under `[backchannel]`; the token is never logged because the output isn't
  a terminal. If the helper exits, the app restarts it after 1 s, 5 s, then
  every 30 s. On quit it gets SIGTERM and runs its own shutdown.
- **Windows.** The helper posts its bridge state to the app
  (`process.parentPort`, three lines in `backchannel.mjs`). The first
  `ready` in a run opens the Backchannel window and hides Signal's. After
  that:
  - `unlinked`, `denied` or `keyMismatch` brings Signal's window back.
  - Signal shows its own window for the approval dialog.
  - Window > Show (⌘⇧0) brings back Signal's window.
  - The Dock menu has "Backchannel" and "Signal Window".
  - Clicking the Dock icon brings back the Backchannel window.
  - Closing the Backchannel window hides it, so its notifications keep
    coming.
- **The window itself.**
  - It uses its own session (`persist:backchannel`), sandboxed, with no
    Node.js access.
  - It may only ask for notifications, copying to the clipboard, the
    microphone (for voice notes, audio only) and full-screen.
  - It can't navigate away from its own page. Web links open in the
    default browser.
- **Dock.** The page's title, "(3) Backchannel", sets the Dock badge.
  Signal's own badge count is ignored once the Backchannel window is the
  main one. Notifications are the page's own web notifications, which macOS
  shows as Backchannel's.

Upstream files touched in M2: `app/main.main.ts` (an import plus three
marked hooks: start, Dock click, badge) and
`ts/main/externalClientMain.main.ts` (an import plus one marked check). New:
`ts/backchannel/`.

### Threat model

Read against `docs/external-client-threat-model.md`. Two things change
for the Backchannel app only. Signal-the-app and the container are
unchanged.

1. **§4 point 4, "off unless the user turns it on".** In the Backchannel
   app the bridge is on from the start. Installing Backchannel is the
   opt-in: nobody runs it except to use the bridge. The switch sits inside
   the signed, integrity-checked `app.asar`, not in a plaintext file in the
   profile, so T12's goal (a plaintext edit can't turn it on) holds. The
   approval dialog (B4) still guards every client, including the built-in
   helper, which is approved once.
2. **A2, "no TCP/HTTP surface for web pages".** The app now always runs the
   helper's loopback HTTP server, which other local programs and browser
   pages can reach. That's the same surface the helper already has
   everywhere it runs (helper README, "Why the local web server is safe
   enough"), but now it's always on in this app. Its guards were checked on
   the packaged build:
   - Without the token, or with a wrong one: 404.
   - A foreign `Host` (DNS rebinding): 421.
   - A foreign `Origin`: 403.
   - It listens on `127.0.0.1` only.

   The token and `key.json` are mode 0600 in a 0700 folder inside the app's
   profile. A3, another user on the same Mac who learns the token, remains
   the residual risk the helper README already names.

Nothing else changes: same user, same capabilities, no new network
listener, and the bridge socket and its authentication are untouched.

### Testing it on a real account

The account test isn't done yet. With your phone at hand:

1. Build: `contrib/backchannel/mac/build.sh`. For a truly fresh install,
   first move `~/Library/Application Support/Backchannel` aside.
2. Open `release/mac-arm64/Backchannel.app`. Signal's window shows
   "Link your account".
3. On the phone: Signal > Settings > Linked devices > Link new device, and
   scan the code. Pick whether to bring over history.
4. When it has synced, Signal shows the approval dialog for "Backchannel".
   Check the capability list, then Allow.
5. The Backchannel window opens and Signal's window hides. Check:
   - Chats and photos load, and you can send and receive.
   - The browser asks once for notifications. Allow, then send yourself a
     message from the phone with the window in the background: a
     Backchannel notification appears, and clicking it opens the chat.
   - The Dock badge matches the unread count.
   - The Dock menu, Window > Show (⌘⇧0) and the Dock icon switch windows
     as described above.
   - Quit and reopen: the Backchannel window comes back without another
     approval.
6. Work through the "Beyond Signal Desktop" list in
   `contrib/backchannel/README.md`. Schedule a message two minutes out and
   leave the app running: it should send on time.
7. Send the log (Help > Debug Log, or
   `~/Library/Application Support/Backchannel/logs/`) if anything fails.
   Lines start with `[backchannel]`.

### Known gaps

- The large emoji font (`fonts/emoji-large.woff2`) returned 404 before
  linking. The helper gets it from Signal's copy in the profile or
  downloads it; check it after linking.
- There's no right-click menu (spellcheck, copy, paste) in the Backchannel
  window, beyond what the page draws itself.
- Window size and position aren't remembered between launches.
- At each launch Signal's window shows briefly before the Backchannel
  window takes over.

## M3: signed, notarized, published (2026-11-04)

Result: **works.** A signed, notarized test build (0.0.2, not published)
passed every check on 2026-11-06. Signing uses 404 Cybersecurity LLC's Developer ID (team
`YA83Q8FTH3`), which is in the releasing Mac's keychain. Releases are
built on that Mac with `release.sh` and hosted on
`breed007/Signal-Desktop`'s GitHub Releases, so no signing secret goes to
GitHub. Steps are in `RELEASING.md`.

### What changed

- `release.sh`: checks the certificate and the notarytool profile, builds
  with the Developer ID, notarizes and staples the app, checks it with
  `stapler`, `spctl` and the smoke test, then signs, notarizes and staples
  the DMG and writes `release/publish-<version>/` (DMG, ZIP, `SHA256SUMS`,
  cask, notes). `--publish` tags the commit and creates the release.
- `smoke-test.sh`: starts the packaged app and expects the helper to
  answer 404 without the token, 200 with it and 421 for another `Host`.
  It finds the helper's port (47830, or the next free one up to 47839), so
  it also works while another helper holds 47830.
- `.github/workflows/mac.yml`: an unsigned check only. It builds and
  smoke-tests on `macos-26` for pushes to `main` that touch Backchannel and
  for `backchannel-mac-v*` tags, and keeps the files 14 days. A first
  version also signed and published from Actions secrets; it was dropped so
  the certificate never leaves the releasing Mac (commit `0eb040651` has
  it, if Mike ever signs with his own account).
- Signing moved from Signal's hooks to electron-builder's own, in
  `electron-builder.config.mjs`:
  - `mac.sign: null` drops Signal's hook, which hands the app to Signal's
    signing script. electron-builder signs with `CSC_NAME` when given and
    falls back to ad-hoc for arm64 otherwise. `build.sh` sets
    `CSC_IDENTITY_AUTO_DISCOVERY=false` when no identity is given, so a
    plain build never picks up a Developer ID from the keychain.
  - `afterSign: null` and `mac.notarize: true`: electron-builder notarizes
    and staples the app with `APPLE_KEYCHAIN_PROFILE`, and logs
    `skipped macOS notarization` without a credential. Signal's hook would
    have used Signal's bundle ID.
  - `afterAllArtifactBuild: null`: Signal's hook notarizes only a
    universal DMG. `release.sh` notarizes the arm64 DMG.
  - `mac.hardenedRuntime` is on only with a Developer ID. **An ad-hoc
    build with the hardened runtime aborts at launch**: library validation
    rejects the ad-hoc `Electron Framework` ("mapping process and mapped
    file (non-platform) have different Team IDs"). The smoke test caught
    this.
- Versions: `BACKCHANNEL_VERSION` goes in the file names
  (`Backchannel-1.11-mac-arm64.dmg`) and `CFBundleVersion`.
  `CFBundleShortVersionString` stays Signal Desktop's (8.36.0-alpha.1 at
  the time), because Signal's servers and the expiry check read it.
- DMG: `dmg/background.tiff` (Signal's layout, Backchannel's teal, 1x and
  2x) and `dmg/icon.icns` (rendered from the app icon). The volume is
  named "Backchannel Installer".
- `homebrew/backchannel.rb`: the cask template, downloading from
  `breed007/Signal-Desktop`'s releases. Rendered with a real SHA-256, it
  passes `brew style` and `brew audit --cask --strict` in a scratch tap.

### Expiry

`scripts/get-expire-time.mjs` sets the expiry to 90 days after the
**commit time** of `HEAD` (`git show -s --format=%ct`), not the build time.
Rebuilding an old commit gives an app that expires just as soon.
`release.sh` warns under 60 days, and the release notes give the date.

### Checked

- Locally: the unsigned DMG and ZIP; the DMG's background and volume icon;
  the smoke test, also with 47830 taken (the helper moved to 47831); the
  cask lint.
- On `breed007/Signal-Desktop`'s Actions: the unsigned build and smoke test
  passed on `macos-26` in about 5 minutes.
- Signed with the 404 Cybersecurity Developer ID but not notarized
  (`CSC_NAME` set, no profile): the app has the hardened runtime and a
  secure timestamp, `codesign --verify --deep --strict` passes, and the
  smoke test passes. So the hardened runtime doesn't break the helper or
  the app; only notarization is left to try.
- `release.sh` stops before building when the profile is missing, with
  the `store-credentials` command to run.
- `release.sh 0.0.2` with the `backchannel` profile (an Apple ID with an
  app-specific password), 2026-11-06:
  - electron-builder logged `notarization successful` for the app;
    `stapler validate` passed; `spctl` said `accepted`,
    `source=Notarized Developer ID`, `origin=Developer ID Application: 404
    Cybersecurity LLC (YA83Q8FTH3)`.
  - The notarized app passed the smoke test.
  - The DMG was signed, notarized (`Accepted`) and stapled; `spctl -t open`
    accepted it as `Notarized Developer ID`.
  - A copy of the DMG with a quarantine flag, as a browser download gets,
    was accepted, and so was the app copied out of it (quarantine carried
    over, `CFBundleVersion` 0.0.2).

### Not done

- A tap: which account hosts `homebrew-backchannel` isn't decided.
- The front-door README text waits for the first release (`RELEASING.md`
  has it).
- The first public release should wait for the real-account test of M2.
