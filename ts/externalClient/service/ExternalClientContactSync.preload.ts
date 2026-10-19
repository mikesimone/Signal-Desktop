// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import { waitForEvent } from '../../shims/events.dom.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { sendSyncRequests } from '../../textsecure/syncRequests.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type { ContactsSyncResultType } from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';

// Fork addition (decision F36): Signal's Settings > Chats > "Import
// contacts" (Preferences' makeSyncRequest). The phone sends its contacts
// again, with the photos from its address book, and contact sync applies
// them as after linking.

const log = createLogger('ExternalClientContactSync');

export async function syncContacts(): Promise<ServiceResultType> {
  // Only a linked device can ask; Signal hides the button on a primary.
  if (itemStorage.user.getDeviceId() === 1) {
    return { ok: false, code: ErrorCode.PreconditionFailed };
  }
  try {
    const complete = waitForEvent('contactSync:complete');
    await Promise.all([sendSyncRequests(), complete]);
  } catch (error) {
    log.warn('syncContacts failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  const syncedAt = Date.now();
  // What Signal's Settings shows as "Last imported".
  await itemStorage.put('synced_at', syncedAt);
  log.info('syncContacts: done');
  const value: ContactsSyncResultType = { syncedAt };
  return { ok: true, value };
}
