// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createGroupV2 } from '../../groups.preload.ts';
import { createLogger } from '../../logging/log.std.ts';
import {
  getCandidateContactsForNewGroup,
  getComposableContacts,
} from '../../state/selectors/conversations.dom.ts';
import { getRegionCode } from '../../state/selectors/user.std.ts';
import * as Errors from '../../types/errors.std.ts';
import { DurationInSeconds } from '../../util/durations/index.std.ts';
import { parseAndFormatPhoneNumber } from '../../util/libphonenumberInstance.std.ts';
import { lookupConversationWithoutServiceId } from '../../util/lookupConversationWithoutServiceId.preload.ts';
import { getUsernameFromSearch } from '../../util/Username.dom.ts';
import { getAvatarVersion, toConversationDTO } from '../conversationDto.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ContactDTO,
  ContactsListParamsType,
  ContactsListResultType,
  ConversationsFindParamsType,
  ConversationsOpenParamsType,
  ConversationsOpenResultType,
  GroupsCreateParamsType,
} from '../protocol.std.ts';
import { ErrorCode, MAX_GROUP_NAME_GRAPHEMES } from '../protocol.std.ts';
import { pullContactPhoto } from './ExternalClientContactSync.preload.ts';
import { toAvatarBytes } from './ExternalClientProfile.preload.ts';
import {
  getGroupMemberContact,
  markConversationOpened,
} from './serviceHelpers.preload.ts';

// Fork addition: Signal's compose button for external clients (decision
// F20): the "New chat" list, finding people by username or phone number,
// and "New group". Each uses the same selectors and calls as Signal's left
// pane composer.

const log = createLogger('ExternalClientCompose');

function getPinnedIds(): ReadonlyArray<string> {
  return window.reduxStore.getState().items.pinnedConversationIds ?? [];
}

function text(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function listContacts({
  forGroup = false,
}: ContactsListParamsType): ServiceResultType {
  const state = window.reduxStore.getState();
  const found = forGroup
    ? getCandidateContactsForNewGroup(state)
    : getComposableContacts(state);
  const contacts: Array<ContactDTO> = found
    .map(conversation => ({
      conversationId: conversation.id,
      title: conversation.title,
      avatarColor: conversation.color ?? null,
      avatarVersion: getAvatarVersion(conversation),
      noteToSelf: conversation.isMe,
      about: text(conversation.about),
      username: text(conversation.username),
      phoneNumber: conversation.isMe ? null : text(conversation.phoneNumber),
    }))
    // As Signal's list: Note to Self first, then by name.
    .sort(
      (a, b) =>
        Number(b.noteToSelf) - Number(a.noteToSelf) ||
        a.title.localeCompare(b.title)
    );
  const value: ContactsListResultType = { contacts };
  return { ok: true, value };
}

async function opened(conversationId: string): Promise<ServiceResultType> {
  const model = window.ConversationController.get(conversationId);
  if (!model || model.id !== conversationId) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  // Decision F37: the phone's contacts first, then the chat.
  await pullContactPhoto(model);
  markConversationOpened(conversationId);
  const value: ConversationsOpenResultType = {
    conversation: toConversationDTO(model.format(), getPinnedIds()),
  };
  return { ok: true, value };
}

// Contacts and groups Signal's composer would offer, and people in a group
// the client can see (Signal's contact card "Message", decision F23);
// nothing else, so this can't reach conversations Signal hides.
export async function openConversation({
  conversationId,
}: ConversationsOpenParamsType): Promise<ServiceResultType> {
  const state = window.reduxStore.getState();
  const offered =
    getComposableContacts(state).some(c => c.id === conversationId) ||
    state.conversations.conversationLookup[conversationId]?.type === 'group' ||
    getGroupMemberContact(conversationId) !== undefined;
  if (!offered) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  return opened(conversationId);
}

export async function findConversation({
  query,
}: ConversationsFindParamsType): Promise<ServiceResultType> {
  const username = getUsernameFromSearch(query);
  const regionCode = getRegionCode(window.reduxStore.getState());
  const phoneNumber = username
    ? undefined
    : parseAndFormatPhoneNumber(query, regionCode);
  if (!username && !phoneNumber?.isValid) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  // Signal's own lookup. Its "not found" dialog and spinner are for its
  // window; the result says it here.
  const noop = () => undefined;
  let conversationId: string | undefined;
  try {
    conversationId = await lookupConversationWithoutServiceId(
      username
        ? {
            type: 'username',
            username,
            showUserNotFoundModal: noop,
            setIsFetchingUUID: noop,
          }
        : {
            type: 'e164',
            e164: phoneNumber?.e164 ?? '',
            phoneNumber: phoneNumber?.userInput ?? query,
            showUserNotFoundModal: noop,
            setIsFetchingUUID: noop,
          }
    );
  } catch (error) {
    log.warn('findConversation failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  if (!conversationId) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  return opened(conversationId);
}

export async function createGroup({
  name,
  memberIds,
  avatar,
  disappearingSeconds,
}: GroupsCreateParamsType): Promise<ServiceResultType> {
  const title = name.trim();
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      title
    ),
  ].length;
  if (graphemes === 0 || graphemes > MAX_GROUP_NAME_GRAPHEMES) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const candidates = new Set(
    getCandidateContactsForNewGroup(window.reduxStore.getState()).map(c => c.id)
  );
  if (!memberIds.every(id => candidates.has(id))) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  let avatarBytes: Uint8Array<ArrayBuffer> | undefined;
  if (avatar !== undefined) {
    avatarBytes = await toAvatarBytes(avatar);
    if (!avatarBytes) {
      return { ok: false, code: ErrorCode.InvalidArgument };
    }
  }
  let conversation;
  try {
    conversation = await createGroupV2({
      name: title,
      avatar: avatarBytes,
      expireTimer:
        disappearingSeconds === undefined
          ? undefined
          : DurationInSeconds.fromSeconds(disappearingSeconds),
      conversationIds: [...new Set(memberIds)],
    });
  } catch (error) {
    log.warn('createGroup failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  log.info(`createGroup: ${memberIds.length} members`);
  return opened(conversation.id);
}
