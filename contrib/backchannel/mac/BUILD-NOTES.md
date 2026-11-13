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
  M3 replaces this with Developer ID signing.

### Don't launch the packaged app yet

The packaged app still has Signal's name and app ID, and a packaged
build deliberately ignores `NODE_CONFIG` and the other config variables
(`app/config.main.ts`, "harden production config against the local
env"). So it would open `~/Library/Application Support/Signal`, which is
official Signal Desktop's real profile, and could migrate that database
to this build's schema. M1 gives the app its own name, app ID and data
folder. Launch a packaged build only after that.

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
