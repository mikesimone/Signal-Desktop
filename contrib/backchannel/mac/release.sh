#!/bin/bash
# Copyright 2026 Brian Reed
# SPDX-License-Identifier: AGPL-3.0-only

# Builds a signed, notarized Backchannel for Mac on this Mac and, with
# --publish, puts it on GitHub Releases. The signing certificate and the
# notarization credential stay in this Mac's keychain; nothing secret goes to
# GitHub. See RELEASING.md.
#
#   contrib/backchannel/mac/release.sh 1.11            # build and check only
#   contrib/backchannel/mac/release.sh 1.11 --publish  # then tag and release
#   ... --publish --prerelease                          # marked as a beta
#
# Environment:
#   SIGNING_IDENTITY  certificate name or SHA-1 to sign with (default: the
#                     Developer ID Application certificate of 404
#                     Cybersecurity LLC, team YA83Q8FTH3)
#   NOTARY_PROFILE    notarytool keychain profile (default: backchannel)
#   RELEASE_REPO      where releases go (default: breed007/Signal-Desktop)

set -euo pipefail

cd "$(dirname "$0")/../../.."

usage() {
  echo "usage: $0 <version, e.g. 1.11> [--publish [--prerelease]]" >&2
  exit 2
}

version="${1:-}"
publish=no
prerelease=no
for arg in "${@:2}"; do
  case "$arg" in
    --publish) publish=yes ;;
    --prerelease) prerelease=yes ;;
    *) usage ;;
  esac
done
if [ "$prerelease" = yes ] && [ "$publish" = no ]; then
  usage
fi
if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  usage
fi

identity="${SIGNING_IDENTITY:-Developer ID Application: 404 Cybersecurity LLC (YA83Q8FTH3)}"
profile="${NOTARY_PROFILE:-backchannel}"
repo="${RELEASE_REPO:-breed007/Signal-Desktop}"
tag="backchannel-mac-v$version"

fail() {
  echo "release: $*" >&2
  exit 1
}

# --- Checks before the long build -------------------------------------------

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "commit or stash your changes first; a release is built from a commit"
fi
commit="$(git rev-parse HEAD)"

if [ "$publish" = yes ]; then
  if git rev-parse -q --verify "refs/tags/$tag" > /dev/null &&
    [ "$(git rev-parse "$tag^{commit}")" != "$commit" ]; then
    fail "$tag already exists on another commit"
  fi
  if gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
    fail "$repo already has a release $tag"
  fi
fi

# The SHA-1 of the identity, so a duplicate copy in a second keychain doesn't
# make codesign ask which one.
hash="$(security find-identity -v -p codesigning |
  awk -v id="$identity" 'index($0, id) { print $2; exit }')"
[ -n "$hash" ] || fail "no valid signing identity matching '$identity' in the keychain"
echo "Signing with $(security find-identity -v -p codesigning | grep -m 1 "$hash" | cut -d '"' -f 2)"

if ! xcrun notarytool history --keychain-profile "$profile" > /dev/null 2>&1; then
  fail "no working notarytool profile '$profile'; create it once with
  xcrun notarytool store-credentials $profile"
fi

expires_in_days="$(node -p '
  const ms = Number(require("node:child_process")
    .execSync("git show -s --format=%ct").toString()) * 1000 + 90 * 864e5;
  Math.floor((ms - Date.now()) / 864e5)')"
if [ "$expires_in_days" -lt 60 ]; then
  echo "Warning: this commit's build expires in $expires_in_days days. Merge a newer Signal Desktop release first?" >&2
fi

out="release/publish-$version"

build_release() {
  # --- Build, sign and notarize the app ----------------------------------------

  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
    APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER CSC_LINK
  BACKCHANNEL_VERSION="$version" CSC_NAME="$hash" \
    APPLE_KEYCHAIN_PROFILE="$profile" \
    contrib/backchannel/mac/build.sh dmg zip

  app=release/mac-arm64/Backchannel.app
  dmg="release/Backchannel-$version-mac-arm64.dmg"
  zip="release/Backchannel-$version-mac-arm64.zip"

  xcrun stapler validate "$app"
  spctl --assess --type execute -vv "$app"

  contrib/backchannel/mac/smoke-test.sh "$app"

  # --- Sign and notarize the DMG -----------------------------------------------

  codesign --sign "$hash" --timestamp "$dmg"
  result="$(mktemp -t backchannel-notary)"
  xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait \
    --output-format json > "$result"
  field() {
    node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).$1" "$result"
  }
  status="$(field status)"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$(field id)" \
      --keychain-profile "$profile" || true
    fail "notarizing the DMG ended as $status"
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature -vv "$dmg"

  # --- Files to publish -------------------------------------------------------

  rm -rf "$out"
  mkdir -p "$out"
  cp "$dmg" "$zip" "$out/"
  (cd "$out" && shasum -a 256 Backchannel-* > SHA256SUMS)
  echo "$commit" > "$out/COMMIT"
  sha="$(shasum -a 256 "$dmg" | cut -d ' ' -f 1)"
  sed -e "s/@VERSION@/$version/" -e "s/@SHA256@/$sha/" \
    contrib/backchannel/mac/homebrew/backchannel.rb > "$out/backchannel.rb"

  signal_version="$(node -p 'require("./package.json").version')"
  expires="$(node -p 'new Date(require("./config/local-production.json").buildExpiration).toISOString().slice(0, 10)')"
  sed -e "s/@VERSION@/$version/g" -e "s/@SIGNAL_VERSION@/$signal_version/g" \
    -e "s/@EXPIRES@/$expires/g" \
    contrib/backchannel/mac/release-notes.md > "$out/notes.md"

  echo
  echo "Built $out (Signal Desktop $signal_version, commit ${commit:0:9}, expires $expires):"
}

# A checked build of this commit is published as it is, not rebuilt.
if [ "$publish" = yes ] && [ -f "$out/COMMIT" ] &&
  [ "$(cat "$out/COMMIT")" = "$commit" ]; then
  echo "Using the build already in $out (commit ${commit:0:9})"
else
  build_release
fi
cat "$out/SHA256SUMS"

if [ "$publish" = no ]; then
  echo
  echo "Not published. To publish this commit: $0 $version --publish"
  exit 0
fi

# --- Publish -----------------------------------------------------------------

if ! git rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
  git tag -a "$tag" -m "Backchannel for Mac $version" "$commit"
fi
git push origin "refs/tags/$tag"
notes="$out/notes.md"
flags=()
if [ "$prerelease" = yes ]; then
  notes="$out/notes-prerelease.md"
  {
    echo "**Beta.** Not yet tested end to end with a linked phone. Report what breaks."
    echo
    cat "$out/notes.md"
  } > "$notes"
  flags=(--prerelease)
fi
gh release create "$tag" --repo "$repo" --verify-tag ${flags[@]+"${flags[@]}"} \
  --title "Backchannel for Mac $version" --notes-file "$notes" \
  "$out"/Backchannel-* "$out/SHA256SUMS"
echo
echo "Published. Copy $out/backchannel.rb to the tap's Casks/ folder."
