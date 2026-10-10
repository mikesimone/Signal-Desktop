// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationModel } from '../../models/conversations.preload.ts';
import type {
  LastMessageStatus,
  MessageAttributesType,
} from '../../model-types.d.ts';
import { DataReader } from '../../sql/Client.preload.ts';
import { getContactNameColorSelector } from '../../state/selectors/conversations.dom.ts';
import { getMessagePropStatus } from '../../state/selectors/message.preload.ts';
import {
  getAvatarVersion,
  isListedConversation,
} from '../conversationDto.std.ts';
import type { MessageDtoContextType } from '../messageDto.std.ts';
import type { AuthorDTO, MessageSendStatusType } from '../protocol.std.ts';
import { MessageSendStatus } from '../protocol.std.ts';

// Lookups shared by the renderer service modules.

// `get` also resolves phone numbers and service ids; only accept our own
// conversation ids so this cannot be used as a lookup oracle. Conversations
// the left pane would not show are treated as missing.
export function getListedConversation(
  conversationId: string
): ConversationModel | undefined {
  const model = window.ConversationController.get(conversationId);
  if (!model || model.id !== conversationId) {
    return undefined;
  }
  return isListedConversation(model.format()) ? model : undefined;
}

const SEND_STATUS: Record<LastMessageStatus, MessageSendStatusType> = {
  sending: MessageSendStatus.Sending,
  paused: MessageSendStatus.Paused,
  error: MessageSendStatus.Failed,
  'partial-sent': MessageSendStatus.PartiallySent,
  sent: MessageSendStatus.Sent,
  delivered: MessageSendStatus.Delivered,
  read: MessageSendStatus.Read,
  viewed: MessageSendStatus.Viewed,
};

// Fork addition: how Signal shows a message's author in a conversation.
function makeGetAuthor(): MessageDtoContextType['getAuthor'] {
  const controller = window.ConversationController;
  const cache = new Map<string, AuthorDTO | null>();
  let nameColorFor: ReturnType<typeof getContactNameColorSelector> | undefined;

  return (authorConversationId, conversationId, serviceId) => {
    const key = `${authorConversationId}:${conversationId}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const authorModel = controller.get(authorConversationId);
    const conversationModel = controller.get(conversationId);
    if (!authorModel || authorModel.id !== authorConversationId) {
      cache.set(key, null);
      return null;
    }
    const author = authorModel.format();
    const conversation = conversationModel?.format();
    const isGroupChat = conversation?.type === 'group';

    let nameColor: string | null = null;
    let label: AuthorDTO['label'] = null;
    if (isGroupChat && conversation) {
      nameColorFor ??= getContactNameColorSelector(
        window.reduxStore.getState()
      );
      nameColor = nameColorFor(conversation.id, authorConversationId);
      const membership = serviceId
        ? conversation.memberships?.find(m => m.aci === serviceId)
        : undefined;
      if (membership?.labelString) {
        label = {
          text: membership.labelString,
          emoji: membership.labelEmoji ?? null,
        };
      }
    }

    const value: AuthorDTO = {
      title: author.title,
      avatarColor: author.color ?? null,
      avatarVersion: getAvatarVersion(author),
      nameColor,
      label,
    };
    cache.set(key, value);
    return value;
  };
}

export function getDtoContext(): MessageDtoContextType {
  const controller = window.ConversationController;
  const ourConversationId = controller.getOurConversationId();
  return {
    getAuthor: makeGetAuthor(),
    resolveConversationId: serviceId => controller.get(serviceId)?.id ?? null,
    ourConversationId: ourConversationId ?? null,
    now: Date.now(),
    getSendStatus: message => {
      const status = getMessagePropStatus(message, ourConversationId);
      return status ? SEND_STATUS[status] : null;
    },
  };
}

// In-memory state wins over the database, as it does for the timeline.
export function preferCached(
  message: MessageAttributesType
): MessageAttributesType {
  return window.MessageCache.getById(message.id)?.attributes ?? message;
}

export async function loadMessage(
  messageId: string
): Promise<MessageAttributesType | undefined> {
  const cached = window.MessageCache.getById(messageId);
  if (cached) {
    return cached.attributes;
  }
  return DataReader.getMessageById(messageId);
}
