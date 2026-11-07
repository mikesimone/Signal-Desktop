# Copyright 2026 Brian Reed
# SPDX-License-Identifier: AGPL-3.0-only

# Template for Casks/backchannel.rb in the Homebrew tap. release.sh fills in
# the version and the DMG's SHA-256 for each release. Releases are hosted on
# breed007/Signal-Desktop (2026-11-04).
cask "backchannel" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/breed007/Signal-Desktop/releases/download/backchannel-mac-v#{version}/Backchannel-#{version}-mac-arm64.dmg"
  name "Backchannel"
  desc "Signal Desktop with Backchannel's chat page built in"
  homepage "https://github.com/mikesimone/backchannel"

  livecheck do
    url :url
    regex(/^backchannel-mac-v(\d+(?:\.\d+)*)$/i)
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Backchannel.app"

  # The keychain item "Backchannel Safe Storage" holds the database key; zap
  # can't remove keychain items, so delete it in Keychain Access if wanted.
  zap trash: [
    "~/Library/Application Support/Backchannel",
    "~/Library/Caches/net.mikesimone.backchannel.mac",
    "~/Library/HTTPStorages/net.mikesimone.backchannel.mac",
    "~/Library/Preferences/net.mikesimone.backchannel.mac.plist",
    "~/Library/Saved Application State/net.mikesimone.backchannel.mac.savedState",
  ]
end
