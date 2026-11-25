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
  mac: {
    ...base.mac,
    artifactName: 'Backchannel-mac-${arch}-${version}.${ext}',
    icon: 'contrib/backchannel/mac/icon/AppIcon.icon',
    // Apple Silicon only (CLAUDE.md rule 4).
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    minimumSystemVersion: '14.0',
    // Never publish to or advertise Signal's update server (rule 5).
    publish: null,
  },
};
