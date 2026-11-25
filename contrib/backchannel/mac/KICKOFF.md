# KICKOFF: Backchannel for Mac

One milestone per Claude Code session. Paste the prompt, let it finish,
review, commit. Each milestone ends at its "done when"; don't run ahead.
Read `contrib/backchannel/mac/CLAUDE.md` first every time.

---

## M0: Build the fork for Apple Silicon, unmodified

**Prompt**

```
Read contrib/backchannel/mac/CLAUDE.md, then CONTRIBUTING.md and the
build-related scripts in package.json. Build this fork for macOS arm64 on
this Mac without changing app code: install the toolchain versions the
repo pins, run the generate and build steps, and produce a runnable .app
(unsigned is fine). Launch it with SIGNAL_ENABLE_EXTERNAL_CLIENTS=1 in an
unpackaged dev run and confirm the bridge socket appears.

Write every step, version, error and fix in
contrib/backchannel/mac/BUILD-NOTES.md. Stop when the app runs and shows
the link QR code. Report anything in CLAUDE.md that turned out wrong.
```

**Done when:** the app launches on an Apple Silicon Mac, shows the link QR
code, and BUILD-NOTES.md lets someone repeat the build.

---

## M1: Rebrand so it runs beside official Signal Desktop

**Prompt**

```
Make the Mac build its own app, per CLAUDE.md rules 3 to 5 and 8:
productName "Backchannel", a Backchannel app ID (ask me for the bundle ID
before using one), its own data folder, the Backchannel icon from
contrib/backchannel/helper/public/icon.svg turned into a Mac icon (upstream
uses an Icon Composer .icon at build/icons/mac/AppIcon.icon), arm64
only, and the updater pointed away from Signal's update server (propose
GitHub Releases or off; ask which). Keep every change to upstream files
small and marked // BACKCHANNEL:, and put Mac-only config under
contrib/backchannel/mac/. Show me the full list of upstream files you
touched and why.
```

**Done when:** Backchannel.app and official Signal.app run at the same
time on one Mac with separate profiles, and the list of touched upstream
files is short.

---

## M2: Bridge on, helper inside, page in its own window

**Prompt**

```
Make the Mac app self-contained:

1. Turn the bridge on for this build at build time (a Backchannel build
   flag read in #isEnabled in ts/main/externalClientMain.main.ts), instead
   of the container's environment variable. Keep the user's approval
   prompt.
2. Start contrib/backchannel/helper/backchannel.mjs inside the app with
   Electron's utilityProcess, with the same flags entrypoint.sh passes,
   except bind to 127.0.0.1 and use a config folder inside the app's data
   folder. Stop it cleanly on quit.
3. Add a "Backchannel" window that loads the helper's page from loopback
   with its token, and make it the main window after linking. Keep Signal's
   own window reachable from the menu for linking and approval.
4. Route the page's notifications and unread badge to the Dock.

Read docs/external-client-threat-model.md first and say if any of this
changes the threat model. Run the helper tests. Then walk me through
testing it on a real account.
```

**Done when:** on a Mac with no Docker and no browser, a fresh install
links to a phone, approves Backchannel once, and every item in the README's
"Beyond Signal Desktop" list works, including scheduled messages while the
app runs.

---

## M3: Sign, notarize and publish

**Prompt**

```
Add .github/workflows/mac.yml: on each backchannel-v* tag, build arm64,
sign with a Developer ID certificate, notarize, staple, and attach a DMG
and a zip to the GitHub Release. Read secrets only from Actions secrets
(list the names you need; I'll set them). Add a Homebrew cask file under
contrib/backchannel/mac/homebrew/ and say which tap it should go in.
Update the front-door README's install section text for Mac (give me the
text; it lives in mikesimone/backchannel).
```

**Done when:** pushing a tag produces a notarized DMG that opens without a
Gatekeeper warning on a clean Mac, and the cask installs it.

---

## Later: Mac v2

Only if Mike wants it: move Backchannel's extras into Signal Desktop's own
React UI, one feature per session, and retire the loopback page.
