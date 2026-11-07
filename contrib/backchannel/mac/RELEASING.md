# Releasing Backchannel for Mac

Releases are built, signed and notarized on a Mac with `release.sh`, and
hosted on `breed007/Signal-Desktop`'s GitHub Releases. The signing
certificate and the notarization credential stay in that Mac's keychain;
no signing secret lives on GitHub. (Decided 2026-11-04: the certificate is
404 Cybersecurity LLC's, and keeping it off GitHub keeps it under their
control.)

`.github/workflows/mac.yml` is only a check: it builds an unsigned app,
starts it and checks the helper, for every push to `main` that touches
Backchannel and for every release tag.

## One-time setup on the releasing Mac

1. **Toolchain.** Node and pnpm as in `BUILD-NOTES.md` (M0), first on
   `PATH`, and `pnpm install --frozen-lockfile`. Also `gh`, signed in with
   write access to `breed007/Signal-Desktop`.
2. **Certificate.** The keychain needs the Developer ID Application
   certificate with its private key: "Developer ID Application: 404
   Cybersecurity LLC (YA83Q8FTH3)". `release.sh` picks it by name; set
   `SIGNING_IDENTITY` to use another.
3. **Notarization profile.** Store a credential once:

   ```sh
   xcrun notarytool store-credentials backchannel
   ```

   It asks for either an App Store Connect API key (the `.p8` file, its key
   ID and the issuer ID) or an Apple ID in team `YA83Q8FTH3` with an
   app-specific password, and keeps it in the keychain under the name
   `backchannel`. Set `NOTARY_PROFILE` to use another name.

## Each release

1. Merge the Signal Desktop release you want into `main`. A build expires
   90 days after the commit it's built from, so rebuilding an old commit
   doesn't buy time; `release.sh` warns when fewer than 60 days are left.
2. Check out that commit with a clean tree, quit Backchannel, and build:

   ```sh
   contrib/backchannel/mac/release.sh 1.11
   ```

   It checks the certificate and the profile first, then:
   - builds with the Developer ID and the hardened runtime, and notarizes
     and staples the app;
   - checks it with `stapler` and `spctl`, starts it and checks that the
     helper serves the page (`smoke-test.sh`);
   - signs, notarizes and staples the DMG, and checks it with `spctl`;
   - writes `release/publish-1.11/`: the DMG, the ZIP, `SHA256SUMS`, the
     cask with the DMG's SHA-256, and the release notes.
3. Try the DMG from `release/publish-1.11/` if anything changed in the
   build or the app.
4. Publish:

   ```sh
   contrib/backchannel/mac/release.sh 1.11 --publish
   ```

   This uses the build from step 2 when it came from the same commit (and
   builds again otherwise), tags the commit `backchannel-mac-v1.11`, pushes
   the tag to `origin` and creates the release with the DMG, the ZIP and
   `SHA256SUMS`. The tag also runs the unsigned check in Actions. Add
   `--prerelease` to mark it as a beta on GitHub, with a line saying so at
   the top of the notes.
5. Copy `release/publish-1.11/backchannel.rb` to the tap's `Casks/`
   folder, once there is a tap.

The release number goes in the file names and the build number
(`CFBundleVersion`). The app's own version stays Signal Desktop's, because
Signal's servers and the expiry check read it.

## Homebrew tap

The cask template is `homebrew/backchannel.rb`; its download URL points at
`breed007/Signal-Desktop`'s releases. A tap is a public repository named
`homebrew-<name>` with the cask in `Casks/`. Which account hosts it isn't
decided yet; the install command follows from it, for example
`brew install --cask breed007/backchannel/backchannel` for
`breed007/homebrew-backchannel`.

## For the front-door README

Once the first release is out, this goes in `mikesimone/backchannel`'s
README, after Quick start. Add the Homebrew line once the tap exists.

````markdown
## On a Mac

Backchannel for Mac is Signal Desktop with the page built in: no server,
no Docker. It needs an Apple Silicon Mac with macOS 14 or later.

Download the DMG from the
[releases](https://github.com/breed007/Signal-Desktop/releases) and drag
Backchannel to Applications.

Open it and link it to your phone like Signal Desktop (Settings > Linked
devices > Link new device). Signal then asks whether to allow
"Backchannel": allow it, and the page opens in Backchannel's own window.
It keeps its data apart from Signal Desktop, so both can run at once.

Install a newer release at least every couple of months: each build stops
working 90 days after it's made.
````
