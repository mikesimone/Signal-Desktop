# CLAUDE.md: Backchannel for Mac

Read this before touching anything for the Mac build. The plan is in
`mikesimone/backchannel` → `apple/` (README, FEATURE-MAP). The longer
reasoning is the doc "Backchannel for Apple: Architecture Review and Plan".

## What this is

A Mac app built from this fork of Signal Desktop. It's Signal Desktop
(Electron) with Backchannel's bridge, helper and page inside it, its own
name and data folder, Apple Silicon only, signed and notarized, shipped on
GitHub Releases and a Homebrew cask. It links to the user's phone like
Signal Desktop does. There is no server and no Docker.

Mac v1 (this work): the app turns the bridge on, starts the helper inside
itself, and shows the Backchannel page in its own window. Mac v2 (later,
only if Mike wants it): the extras move into Signal Desktop's own UI.

## Where things are

| Path | What |
|---|---|
| `ts/externalClient/` | The bridge (Mike's). Don't change it for the Mac build unless a milestone says so. |
| `ts/main/externalClientMain.main.ts` | Where the bridge decides whether it's enabled (`#isEnabled`). |
| `contrib/backchannel/helper/` | The helper (Node, `backchannel.mjs`, `server.mjs`, `bridge.mjs`) and the page (`public/`). |
| `contrib/backchannel/patches/0001-enable-bridge-from-env.patch` | How the container turns the bridge on (`SIGNAL_ENABLE_EXTERNAL_CLIENTS=1`, packaged or not). |
| `contrib/backchannel/Dockerfile`, `entrypoint.sh` | How the container starts Signal and the helper today. Read them to see the helper's flags. |
| `contrib/backchannel/mac/` | New: everything Mac-only (config, icon, scripts, BUILD-NOTES.md). |
| `.github/workflows/mac.yml` | New: build, sign, notarize, publish. |
| `docs/external-client-*.md` | Architecture, threat model, decisions. Read before changing anything security-related. |

## Rules

1. **Small, marked changes.** Every edit to upstream Signal code carries a
   `// BACKCHANNEL:` comment saying why. New Mac-only code lives under
   `contrib/backchannel/mac/` or a clearly named Backchannel file. The fork
   merges every Signal Desktop release; anything that makes merges harder
   needs a reason.
2. **Don't weaken the bridge's security.** It stays capability-scoped with
   the approval prompt, Signal's key pinning and the helper's token. On the
   Mac the helper binds to `127.0.0.1` only, never `0.0.0.0` (the container
   uses `--bind 0.0.0.0` because Docker forwards the port; the Mac must not).
3. **Coexist with official Signal Desktop.** Different `productName`, app
   ID and data folder (not `~/Library/Application Support/Signal`).
   Running both at once must not share a profile.
4. **Apple Silicon only.** `arm64`, macOS 14 or later unless Signal Desktop
   needs newer. No universal or Intel build.
5. **No Signal update server.** Point the updater at this fork's GitHub
   Releases, or turn it off and rely on Homebrew. Signal Desktop builds
   expire about 90 days after they're built, so every release must come
   from a recent merge.
6. **No secrets in the repo.** Signing certificate, Apple ID, app-specific
   password and team ID live only in Actions secrets.
7. **Mike's calls stand.** He owns this fork. If something here conflicts
   with a decision in `docs/external-client-decisions.md` or Mike's README,
   stop and ask instead of choosing.
8. **Brand rules.** Name "Backchannel". Every About screen and README says
   it's not made, endorsed or supported by Signal Messenger.

## Building (to verify in M0)

Signal Desktop's own steps are the starting point: `CONTRIBUTING.md` and
`package.json` scripts (`pnpm install`, `pnpm run generate`,
`pnpm run build`). Record every real step, version and fix in
`contrib/backchannel/mac/BUILD-NOTES.md`. Nothing in this file has been
run yet.

## Testing

- Helper: `node --test contrib/backchannel/helper/test/` (uses
  `fake-bridge.mjs`, so no Signal account is needed).
- Signal Desktop's own tests: `pnpm test` (slow; run the parts touched).
- On a real Mac: link to a phone, approve the page, send and receive, check
  each item in the helper's PARITY.md "works" list and the README's "Beyond
  Signal Desktop" list.

## Don't

- Don't ship a Mac App Store build (`prepare-mas-build` exists upstream;
  it's out of scope).
- Don't add a server, relay or account of our own.
- Don't open pull requests to signalapp repositories.
