// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { BodyRange } from '../types/BodyRange.std.ts';
import type { AttachmentType } from '../types/Attachment.std.ts';
import type { MessagePollVoteType } from '../types/Polls.dom.ts';
import {
  isGIF,
  isImageAttachment,
  isVoiceMessage,
} from '../util/Attachment.std.ts';
import type {
  AttachmentMetadataDTO,
  AuthorDTO,
  MentionDTO,
  MessageDTO,
  MessageKindType,
  MessageSendStatusType,
  QuoteDTO,
  ReactionDTO,
  StickerDTO,
  FormattingDTO,
  LinkPreviewDTO,
  PollDTO,
} from './protocol.std.ts';
import { MessageKind } from './protocol.std.ts';

// Maps Signal's message attributes to the public DTO. Like the conversation
// mapper, fields are copied one by one so that new internal fields never
// reach clients by accident.

export type MessageSourceType = Pick<
  MessageAttributesType,
  | 'id'
  | 'conversationId'
  | 'type'
  | 'sent_at'
  | 'received_at_ms'
  | 'body'
  | 'bodyAttachment'
  | 'bodyRanges'
  | 'attachments'
  | 'sticker'
  | 'quote'
  | 'isViewOnce'
  | 'isErased'
  | 'deletedForEveryone'
  | 'editHistory'
  | 'expireTimer'
  | 'expirationStartTimestamp'
  | 'readStatus'
  | 'reactions'
  | 'sourceServiceId'
  // Read only by `getSendStatus`.
  | 'deletedForEveryoneFailed'
  | 'deletedForEveryoneSendStatus'
  | 'errors'
  | 'sendStateByConversationId'
  | 'preview'
  | 'poll'
>;

export type MessageDtoContextType = Readonly<{
  // Maps a service id to our conversation id for that person, or null.
  // Must not create conversations.
  resolveConversationId: (serviceId: string) => string | null;
  ourConversationId: string | null;
  now: number;
  // Signal's own status for an outgoing message, as the timeline shows it.
  getSendStatus: (message: MessageSourceType) => MessageSendStatusType | null;
  // How Signal shows this author in this conversation (name, photo, and in
  // groups their name color and member label). `serviceId` is the author's,
  // to find their group membership. Must not create conversations.
  getAuthor: (
    authorConversationId: string,
    conversationId: string,
    serviceId: string | undefined
  ) => AuthorDTO | null;
  // The name Signal shows for a conversation, or null.
  getTitle: (conversationId: string) => string | null;
  // Whether Signal's message menu would offer Edit and Delete for everyone.
  getActions: (
    message: MessageSourceType
  ) => Readonly<{ canEdit: boolean; canDeleteForEveryone: boolean }>;
}>;

function getMessageExpiresAt(
  message: Pick<MessageSourceType, 'expireTimer' | 'expirationStartTimestamp'>
): number | null {
  const { expireTimer, expirationStartTimestamp } = message;
  if (!expireTimer || !expirationStartTimestamp) {
    return null;
  }
  return expirationStartTimestamp + expireTimer * 1000;
}

function getKind(message: MessageSourceType): MessageKindType {
  if (message.deletedForEveryone) {
    return MessageKind.Deleted;
  }
  if (message.isViewOnce) {
    return MessageKind.ViewOnce;
  }
  if (message.sticker) {
    return MessageKind.Sticker;
  }
  if (message.poll) {
    return MessageKind.Poll;
  }
  if (message.body || message.attachments?.length) {
    return MessageKind.Text;
  }
  return MessageKind.Unsupported;
}

// The same reading of votes as the timeline (getPollForMessage).
function toPoll(
  message: MessageSourceType,
  context: MessageDtoContextType
): PollDTO | null {
  const { poll } = message;
  if (!poll) {
    return null;
  }
  const ourId = context.ourConversationId;
  let mineSent: ReadonlyArray<number> = [];
  let minePending: ReadonlyArray<number> | null = null;
  const newest = new Map<string, MessagePollVoteType>();
  for (const vote of poll.votes ?? []) {
    const unsent =
      vote.sendStateByConversationId != null &&
      Object.keys(vote.sendStateByConversationId).length > 0;
    if (vote.fromConversationId === ourId && unsent) {
      minePending = vote.optionIndexes;
      continue;
    }
    if (vote.sendStateByConversationId) {
      continue;
    }
    const existing = newest.get(vote.fromConversationId);
    if (
      !existing ||
      vote.voteCount > existing.voteCount ||
      (vote.voteCount === existing.voteCount &&
        vote.timestamp > existing.timestamp)
    ) {
      newest.set(vote.fromConversationId, vote);
    }
  }
  const voters = new Set<string>();
  const options = poll.options.map((text, index) => {
    const picked = [...newest.values()]
      .filter(vote => vote.optionIndexes.includes(index))
      .map(vote => vote.fromConversationId);
    for (const id of picked) {
      voters.add(id);
    }
    if (ourId && newest.get(ourId)?.optionIndexes.includes(index)) {
      mineSent = [...mineSent, index];
    }
    return { text, voters: [...new Set(picked)] };
  });
  const mine = new Set(minePending ?? mineSent);
  const ended = poll.terminatedAt != null;
  return {
    question: poll.question,
    allowMultiple: poll.allowMultiple,
    options: options.map((option, index) => ({
      ...option,
      mine: mine.has(index),
    })),
    uniqueVoters: voters.size,
    ended,
    pending: minePending != null,
    canEnd: message.type === 'outgoing' && !ended,
  };
}

function toMentions(
  message: MessageSourceType,
  context: MessageDtoContextType
): Array<MentionDTO> {
  return (message.bodyRanges ?? []).filter(BodyRange.isMention).map(range => {
    const conversationId = context.resolveConversationId(range.mentionAci);
    return {
      start: range.start,
      length: range.length,
      conversationId,
      title: conversationId ? context.getTitle(conversationId) : null,
    };
  });
}

const FORMATTING_STYLES: Partial<
  Record<BodyRange.Style, FormattingDTO['style']>
> = {
  [BodyRange.Style.BOLD]: 'bold',
  [BodyRange.Style.ITALIC]: 'italic',
  [BodyRange.Style.STRIKETHROUGH]: 'strikethrough',
  [BodyRange.Style.MONOSPACE]: 'monospace',
  [BodyRange.Style.SPOILER]: 'spoiler',
};

function toFormatting(message: MessageSourceType): Array<FormattingDTO> {
  const result = new Array<FormattingDTO>();
  for (const range of message.bodyRanges ?? []) {
    if (!BodyRange.isFormatting(range)) {
      continue;
    }
    const style = FORMATTING_STYLES[range.style];
    if (style) {
      result.push({ start: range.start, length: range.length, style });
    }
  }
  return result;
}

function toPreviews(message: MessageSourceType): Array<LinkPreviewDTO> {
  return (message.preview ?? []).map(preview => ({
    url: preview.url,
    title: preview.title ?? null,
    description: preview.description ?? null,
    domain: preview.domain ?? null,
    hasImage: Boolean(preview.image?.path || preview.image?.thumbnail?.path),
  }));
}

// `fromId` is already a conversation id. Reactions being removed have no
// emoji and are left out.
function toReactions(
  message: MessageSourceType,
  context: MessageDtoContextType
): Array<ReactionDTO> {
  return (message.reactions ?? [])
    .filter(reaction => reaction.emoji)
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map(reaction => ({
      emoji: reaction.emoji ?? '',
      authorConversationId: reaction.fromId,
      fromMe: reaction.fromId === context.ourConversationId,
    }));
}

function getAttachmentState(
  attachment: AttachmentType
): AttachmentMetadataDTO['state'] {
  if (attachment.path) {
    return 'ready';
  }
  if (attachment.pending) {
    return 'downloading';
  }
  if (
    attachment.error ||
    attachment.isCorrupted ||
    attachment.wasTooBig ||
    attachment.backfillError
  ) {
    return 'failed';
  }
  return 'notDownloaded';
}

// Whether the service can produce a preview image right now.
export function hasAttachmentThumbnail(attachment: AttachmentType): boolean {
  return Boolean(
    attachment.thumbnail?.path ||
    attachment.screenshot?.path ||
    (isImageAttachment(attachment) && attachment.path)
  );
}

function toAttachments(
  message: MessageSourceType
): Array<AttachmentMetadataDTO> {
  return (message.attachments ?? []).map(attachment => ({
    contentType: attachment.contentType,
    size: attachment.size,
    fileName: attachment.fileName ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    state: getAttachmentState(attachment),
    hasThumbnail: hasAttachmentThumbnail(attachment),
    isVoiceMessage: isVoiceMessage(attachment),
    isGif: isGIF(attachment),
    caption: attachment.caption ?? null,
    blurHash: attachment.blurHash ?? null,
  }));
}

function toSticker(message: MessageSourceType): StickerDTO | null {
  const { sticker } = message;
  if (!sticker) {
    return null;
  }
  return {
    emoji: sticker.emoji ?? null,
    width: sticker.width ?? sticker.data?.width ?? null,
    height: sticker.height ?? sticker.data?.height ?? null,
    ready: Boolean(sticker.data?.path),
  };
}

function toQuote(
  message: MessageSourceType,
  context: MessageDtoContextType
): QuoteDTO | null {
  const { quote } = message;
  if (!quote) {
    return null;
  }
  const authorConversationId = quote.authorAci
    ? context.resolveConversationId(quote.authorAci)
    : null;
  return {
    authorConversationId,
    author: authorConversationId
      ? context.getAuthor(
          authorConversationId,
          message.conversationId,
          quote.authorAci
        )
      : null,
    sentAt: quote.id,
    // A quote of a view-once message must not reveal it.
    text: quote.isViewOnce ? null : (quote.text ?? null),
  };
}

// Returns undefined for messages that are not shown as chat messages
// (notifications, group updates, call history...) and for disappearing
// messages that have already expired.
export function toMessageDTO(
  message: MessageSourceType,
  context: MessageDtoContextType
): MessageDTO | undefined {
  const { type } = message;
  if (type !== 'incoming' && type !== 'outgoing') {
    return undefined;
  }

  const expiresAt = getMessageExpiresAt(message);
  if (expiresAt != null && expiresAt <= context.now) {
    return undefined;
  }

  const kind = getKind(message);
  // Content of deleted, erased and view-once messages never crosses.
  const hidden =
    kind === MessageKind.Deleted ||
    kind === MessageKind.ViewOnce ||
    Boolean(message.isErased);

  let authorConversationId: string | null;
  let author: AuthorDTO | null = null;
  if (type === 'outgoing') {
    authorConversationId = context.ourConversationId;
  } else {
    authorConversationId = message.sourceServiceId
      ? context.resolveConversationId(message.sourceServiceId)
      : null;
    author = authorConversationId
      ? context.getAuthor(
          authorConversationId,
          message.conversationId,
          message.sourceServiceId
        )
      : null;
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: type,
    kind,
    authorConversationId,
    author,
    sentAt: message.sent_at,
    receivedAt: message.received_at_ms ?? null,
    body: hidden ? null : (message.body ?? null),
    bodyTruncated: !hidden && message.bodyAttachment != null,
    mentions: hidden ? [] : toMentions(message, context),
    attachments: hidden ? [] : toAttachments(message),
    sticker: hidden ? null : toSticker(message),
    formatting: hidden ? [] : toFormatting(message),
    previews: hidden ? [] : toPreviews(message),
    poll: hidden ? null : toPoll(message, context),
    ...(hidden
      ? { canEdit: false, canDeleteForEveryone: false }
      : context.getActions(message)),
    quote: hidden ? null : toQuote(message, context),
    edited: (message.editHistory?.length ?? 0) > 1,
    expiresAt,
    read: type === 'incoming' ? message.readStatus !== ReadStatus.Unread : null,
    sendStatus: type === 'outgoing' ? context.getSendStatus(message) : null,
    reactions: hidden ? [] : toReactions(message, context),
  };
}
