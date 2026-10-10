// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationType } from '../state/ducks/conversations.preload.ts';
import { isConversationMuted } from '../util/isConversationMuted.std.ts';
import type { ConversationDTO, LastMessageDTO } from './protocol.std.ts';

// Maps Signal's conversation view model to the public DTO. Fields are copied
// one by one on purpose: a new internal field must never reach clients just
// because it was added to ConversationType.

export type ConversationSourceType = Pick<
  ConversationType,
  | 'id'
  | 'type'
  | 'title'
  | 'activeAt'
  | 'unreadCount'
  | 'unreadMentionsCount'
  | 'markedUnread'
  | 'lastMessageReceivedAtMs'
  | 'timestamp'
  | 'muteExpiresAt'
  | 'isArchived'
  | 'isPinned'
  | 'isBlocked'
  | 'isMe'
  | 'acceptedMessageRequest'
  | 'membersCount'
  | 'avatarUrl'
  | 'avatarHash'
  | 'color'
  | 'lastMessage'
>;

// A polynomial string hash, as hex. Turns internal values into an opaque
// version string.
function opaqueVersion(input: string): string {
  const modulus = 4_294_967_291;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 131 + input.charCodeAt(i)) % modulus;
  }
  return hash.toString(16).padStart(8, '0');
}

// Null when there is no photo. The local URL changes whenever the photo
// file does; it is hashed so that no path reaches clients.
export function getAvatarVersion(
  conversation: Pick<ConversationSourceType, 'avatarUrl' | 'avatarHash'>
): string | null {
  if (!conversation.avatarUrl) {
    return null;
  }
  return opaqueVersion(
    `${conversation.avatarUrl}\0${conversation.avatarHash ?? ''}`
  );
}

// The chat list's preview line, with mentions written out.
function toLastMessage(
  lastMessage: ConversationSourceType['lastMessage']
): LastMessageDTO | null {
  if (!lastMessage) {
    return null;
  }
  if (lastMessage.deletedForEveryone) {
    return { text: null, author: null, deleted: true };
  }
  let { text } = lastMessage;
  const mentions = [...(lastMessage.bodyRanges ?? [])]
    .filter(range => 'replacementText' in range)
    .sort((a, b) => b.start - a.start);
  for (const range of mentions) {
    if ('replacementText' in range) {
      text =
        text.slice(0, range.start) +
        `@${range.replacementText}` +
        text.slice(range.start + range.length);
    }
  }
  return {
    text: lastMessage.prefix ? `${lastMessage.prefix} ${text}` : text,
    author: lastMessage.author ?? null,
    deleted: false,
  };
}

// Same rule as the left pane (_getLeftPaneLists): a conversation is listed
// when it is pinned or has had activity.
export function isListedConversation(
  conversation: ConversationSourceType
): boolean {
  // Fork addition: Note to Self is always there, as in Signal's search.
  if (conversation.isPinned || conversation.isMe) {
    return true;
  }
  return conversation.activeAt != null && conversation.activeAt !== 0;
}

export function toConversationDTO(
  conversation: ConversationSourceType,
  // Signal's pinned order (the pinnedConversationIds item).
  pinnedIds: ReadonlyArray<string> = []
): ConversationDTO {
  let pinnedIndex: number | null = null;
  if (conversation.isPinned) {
    const at = pinnedIds.indexOf(conversation.id);
    pinnedIndex = at === -1 ? pinnedIds.length : at;
  }
  const lastActivityAt =
    conversation.lastMessageReceivedAtMs || conversation.timestamp || null;
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    unreadCount: conversation.unreadCount ?? 0,
    unreadMentionsCount: conversation.unreadMentionsCount ?? 0,
    markedUnread: conversation.markedUnread ?? false,
    lastActivityAt,
    muted: isConversationMuted(conversation),
    archived: conversation.isArchived ?? false,
    pinned: conversation.isPinned ?? false,
    blocked: conversation.isBlocked ?? false,
    noteToSelf: conversation.isMe,
    messageRequestPending: !conversation.acceptedMessageRequest,
    memberCount:
      conversation.type === 'group'
        ? (conversation.membersCount ?? null)
        : null,
    avatarColor: conversation.color ?? null,
    avatarVersion: getAvatarVersion(conversation),
    lastMessage: toLastMessage(conversation.lastMessage),
    pinnedIndex,
  };
}
