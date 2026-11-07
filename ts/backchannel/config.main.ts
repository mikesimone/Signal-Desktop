// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Backchannel: not made, endorsed or supported by Signal Messenger.

import config from '../../app/config.main.ts';

// True in the Backchannel app (contrib/backchannel/mac/build.sh writes
// `"backchannelApp": true` into the packaged config/local-production.json,
// which sits inside the integrity-checked app.asar). A plaintext file in the
// user's profile can't set it. Development runs can opt in with
// config/local-development.json.
export function isBackchannelApp(): boolean {
  return config.has('backchannelApp') && config.get('backchannelApp') === true;
}
