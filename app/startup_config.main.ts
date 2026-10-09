// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from 'electron';

import { packageJson } from '../ts/util/packageJson.main.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import * as GlobalErrors from './global_errors.main.ts';

const log = createLogger('startup_config');

GlobalErrors.addHandler();

// Set umask early on in the process lifecycle to ensure file permissions are
// set such that only we have read access to our files
process.umask(0o077);

// Fork-only (not upstream): unpackaged builds get their own AUMID so a dev
// run cannot take over the installed Signal's Start menu entry or taskbar
// grouping on Windows.
export const AUMID = app.isPackaged
  ? `org.whispersystems.${packageJson.name}`
  : `org.whispersystems.${packageJson.name}.development`;
log.info('Set Windows Application User Model ID (AUMID)', {
  AUMID,
});
app.setAppUserModelId(AUMID);
