// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import { waitForEvent } from '../../shims/events.dom.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { sendSyncRequests } from '../../textsecure/syncRequests.preload.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import { sleep } from '../../util/sleep.std.ts';
import {
  isDirectConversation,
  isMe,
} from '../../util/whatTypeOfConversation.dom.ts';
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

// Decision F37: before a new chat opens, ask the phone for its contacts
// once, so a person in them opens with the name and photo from there. Capped
// so a phone that's offline only delays the chat, and at most once a minute.
const PULL_TIMEOUT_MS = 15_000;
const PULL_EVERY_MS = 60_000;
let lastPullAt = 0;

export async function pullContactPhoto(
  model: ConversationModel
): Promise<void> {
  const attrs = model.attributes;
  if (
    !isDirectConversation(attrs) ||
    isMe(attrs) ||
    attrs.avatar?.path ||
    itemStorage.user.getDeviceId() === 1 ||
    Date.now() - lastPullAt < PULL_EVERY_MS
  ) {
    return;
  }
  lastPullAt = Date.now();
  const pulled = Promise.all([
    sendSyncRequests(),
    waitForEvent('contactSync:complete'),
  ]).then(
    () => itemStorage.put('synced_at', Date.now()),
    error => log.warn('pullContactPhoto failed', Errors.toLogFormat(error))
  );
  await Promise.race([pulled, sleep(PULL_TIMEOUT_MS)]);
  log.info(
    `pullContactPhoto: ${model.attributes.avatar?.path ? 'found' : 'none'}`
  );
}
