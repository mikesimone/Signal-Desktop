// Copyright 2026 Brian Reed
// SPDX-License-Identifier: AGPL-3.0-only

// electron-builder config for Backchannel for Mac. It starts from Signal
// Desktop's own `build` block in package.json and overrides only what makes
// this a separate app, so upstream merges keep flowing into the Mac build
// without edits to package.json. Used by build.sh.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
);
const base = packageJson.build;

// The Backchannel release number (1.11 from the tag backchannel-mac-v1.11).
// The app keeps Signal Desktop's version, which Signal's servers and its
// expiry check read, so this one goes in the build number and the file names.
const version = process.env.BACKCHANNEL_VERSION || '0';
if (!/^\d+(\.\d+){0,2}$/.test(version)) {
  throw new Error(`BACKCHANNEL_VERSION must look like 1.11, not ${version}`);
}

// build.sh signs with a Developer ID when one is given and ad-hoc otherwise.
const developerId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

export default {
  ...base,
  // Its own bundle ID, so macOS keeps its notifications, keychain items and
  // preferences apart from official Signal Desktop's.
  appId: 'net.mikesimone.backchannel.mac',
  productName: 'Backchannel',
  extraMetadata: {
    environment: 'production',
    // Electron names the data folder after productName:
    // ~/Library/Application Support/Backchannel, not .../Signal.
    productName: 'Backchannel',
  },
  directories: { output: 'release' },
  // The helper and its page run from inside app.asar, so the asar integrity
  // check covers them too (ts/backchannel/app.main.ts starts the helper).
  files: [
    ...base.files,
    'contrib/backchannel/helper/**',
    '!contrib/backchannel/helper/test/**',
  ],
  // Signal's afterSign hook notarizes under Signal's bundle ID from
  // package.json. electron-builder's own notarization (mac.notarize below)
  // takes its place. The universal-DMG hook never matches an arm64 DMG, so
  // release.sh notarizes the DMG itself.
  afterSign: null,
  afterAllArtifactBuild: null,
  mac: {
    ...base.mac,
    artifactName: `Backchannel-${version}-mac-\${arch}.\${ext}`,
    bundleVersion: version,
    icon: 'contrib/backchannel/mac/icon/AppIcon.icon',
    // Apple Silicon only (CLAUDE.md rule 4).
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    minimumSystemVersion: '14.0',
    // Signal's sign hook hands the app to Signal's own signing script.
    // electron-builder's signing uses a Developer ID certificate when one is
    // given (CSC_NAME in the workflow) and an ad-hoc signature otherwise.
    sign: null,
    // Notarizing needs the hardened runtime. An ad-hoc build can't have it:
    // its library validation then refuses the ad-hoc Electron Framework and
    // the app aborts at launch.
    hardenedRuntime: developerId,
    // Notarizes when a credential is given (release.sh sets
    // APPLE_KEYCHAIN_PROFILE); skipped without one.
    notarize: true,
    // Never publish to or advertise Signal's update server (rule 5).
    publish: null,
  },
  dmg: {
    ...base.dmg,
    background: 'contrib/backchannel/mac/dmg/background.tiff',
    icon: 'contrib/backchannel/mac/dmg/icon.icns',
  },
};
