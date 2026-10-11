// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import { drop } from '../../util/drop.std.ts';
import { Emoji } from '../../axo/emoji.std.ts';
import { enqueueReactionForSend } from '../../reactions/enqueueReactionForSend.preload.ts';
import {
  getEmojiSkinToneDefault,
  getPreferredReactionEmoji,
} from '../../state/selectors/items.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import type { AttachmentType } from '../../types/Attachment.std.ts';
import { isImageAttachment } from '../../util/Attachment.std.ts';
import { getLocalAttachmentUrl } from '../../util/getLocalAttachmentUrl.std.ts';
import { getLocalAvatarUrl } from '../../util/avatarUtils.preload.ts';
import { isSignalConversation } from '../../util/isSignalConversation.dom.ts';
import { getAvatarVersion } from '../conversationDto.std.ts';
import { sendEditedMessage } from '../../util/sendEditedMessage.preload.ts';
import { sendDeleteForEveryoneMessage } from '../../util/sendDeleteForEveryoneMessage.preload.ts';
import { getMessageSentTimestamp } from '../../util/getMessageSentTimestamp.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import type {
  AttachmentsDownloadParamsType,
  AttachmentsGetThumbnailParamsType,
  AttachmentsGetThumbnailResultType,
  AttachmentsReadParamsType,
  AttachmentsReadResultType,
  ConversationsGetAvatarParamsType,
  ConversationsGetAvatarResultType,
  EmojiGetCatalogResultType,
  EmojiMarkUsedParamsType,
  MessagesDeleteParamsType,
  MessagesEditParamsType,
  MessagesReactParamsType,
  ReactionsGetPreferredResultType,
} from '../protocol.std.ts';
import {
  AVATAR_SIZE_PX,
  ErrorCode,
  THUMBNAIL_SIZE_PX,
} from '../protocol.std.ts';
import { toMentionRanges } from './ExternalClientMentions.preload.ts';
import { getSendBlockReason } from './ExternalClientSend.preload.ts';
import {
  getDtoContext,
  getListedConversation,
  loadMessage,
} from './serviceHelpers.preload.ts';

// Fork-only methods (not part of the upstream proposal): avatars and
// reactions, for clients that want to look like Signal.

const log = createLogger('ExternalClientExtras');

const notFound: ServiceResultType = { ok: false, code: ErrorCode.NotFound };

// Avatars of listed conversations, and of anyone who appears as a message
// author (group members usually have no listed conversation of their own).
// Only our own conversation ids are accepted, as everywhere else.
export async function getAvatar({
  conversationId,
}: ConversationsGetAvatarParamsType): Promise<ServiceResultType> {
  const model = window.ConversationController.get(conversationId);
  if (!model || model.id !== conversationId) {
    return notFound;
  }
  if (model.isBlocked() || isSignalConversation(model.attributes)) {
    return notFound;
  }
  const conversation = model.format();
  const avatarVersion = getAvatarVersion(conversation);
  const url = getLocalAvatarUrl(model.attributes);
  if (!avatarVersion || !url) {
    return notFound;
  }

  try {
    // The same decrypting URL the timeline loads the photo from.
    const image = await renderImage(url, { square: AVATAR_SIZE_PX });
    if (!image) {
      return notFound;
    }
    const value: ConversationsGetAvatarResultType = {
      avatarVersion,
      contentType: image.contentType,
      data: image.data,
    };
    return { ok: true, value };
  } catch (error) {
    log.warn('getAvatar: could not read avatar', Errors.toLogFormat(error));
    return notFound;
  }
}

type RenderedImageType = Readonly<{
  contentType: 'image/webp' | 'image/png';
  width: number;
  height: number;
  data: string;
}>;

// Decodes an image from a local (decrypting) URL and re-encodes it: either
// cover-cropped to a square, or scaled to fit within `fit` pixels.
// Base64 of the result must fit in a frame with room to spare.
const MAX_RENDERED_BASE64 = 900 * 1024;

async function renderImage(
  url: string,
  size: Readonly<{ square: number } | { fit: number } | { width: number }>
): Promise<RenderedImageType | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    return undefined;
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) {
      return undefined;
    }
    let sx = 0;
    let sy = 0;
    let sw = width;
    let sh = height;
    let dw: number;
    let dh: number;
    if ('square' in size) {
      const side = Math.min(width, height);
      sx = (width - side) / 2;
      sy = (height - side) / 2;
      sw = side;
      sh = side;
      dw = size.square;
      dh = size.square;
    } else {
      const scale =
        'fit' in size
          ? Math.min(1, size.fit / Math.max(width, height))
          : Math.min(1, size.width / width, (size.width * 4) / height);
      dw = Math.max(1, Math.round(width * scale));
      dh = Math.max(1, Math.round(height * scale));
    }
    // Lower the quality, then the size, until it fits in a frame.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = new OffscreenCanvas(dw, dh);
      const context = canvas.getContext('2d');
      if (!context) {
        return undefined;
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
      // oxlint-disable-next-line no-await-in-loop
      let blob = await canvas.convertToBlob({
        type: 'image/webp',
        quality: attempt === 0 ? 0.9 : 0.75,
      });
      if (blob.type !== 'image/webp') {
        // oxlint-disable-next-line no-await-in-loop
        blob = await canvas.convertToBlob({ type: 'image/png' });
      }
      // oxlint-disable-next-line no-await-in-loop
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const data = Buffer.from(bytes).toString('base64');
      if (data.length <= MAX_RENDERED_BASE64) {
        return {
          contentType: blob.type === 'image/webp' ? 'image/webp' : 'image/png',
          width: dw,
          height: dh,
          data,
        };
      }
      if (attempt > 0) {
        dw = Math.max(1, Math.round(dw * 0.75));
        dh = Math.max(1, Math.round(dh * 0.75));
      }
    }
    return undefined;
  } finally {
    bitmap.close();
  }
}

// The attachment (or sticker) a client may read: the message must be in a
// listed conversation and its DTO must show the attachment, so view-once,
// deleted and erased content is never reachable.
async function findAttachment({
  messageId,
  index,
  sticker,
  preview,
}: AttachmentsGetThumbnailParamsType): Promise<AttachmentType | undefined> {
  const targets = [index, sticker, preview].filter(t => t !== undefined);
  if (targets.length !== 1) {
    return undefined;
  }
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return undefined;
  }
  const dto = toMessageDTO(message, getDtoContext());
  if (!dto) {
    return undefined;
  }
  if (sticker) {
    return dto.sticker ? message.sticker?.data : undefined;
  }
  if (preview !== undefined) {
    return dto.previews[preview]?.hasImage
      ? message.preview?.[preview]?.image
      : undefined;
  }
  if (index === undefined || index >= dto.attachments.length) {
    return undefined;
  }
  return message.attachments?.[index];
}

export async function getAttachmentThumbnail(
  params: AttachmentsGetThumbnailParamsType
): Promise<ServiceResultType> {
  const attachment = await findAttachment(params);
  if (!attachment) {
    return notFound;
  }
  // Drawn from the full image, as the timeline does, so the preview is
  // sharp at any size; Signal's own small thumbnail only as a fallback.
  let source: Pick<AttachmentType, 'path'> | undefined;
  if (
    (isImageAttachment(attachment) ||
      params.sticker ||
      params.preview !== undefined) &&
    attachment.path
  ) {
    source = attachment;
  } else if (attachment.screenshot?.path) {
    source = attachment.screenshot;
  } else if (attachment.thumbnail?.path) {
    source = attachment.thumbnail;
  }
  if (!source) {
    return notFound;
  }
  try {
    const image = await renderImage(
      getLocalAttachmentUrl(source),
      params.width ? { width: params.width } : { fit: THUMBNAIL_SIZE_PX }
    );
    if (!image) {
      return notFound;
    }
    const value: AttachmentsGetThumbnailResultType = image;
    return { ok: true, value };
  } catch (error) {
    log.warn('getAttachmentThumbnail failed', Errors.toLogFormat(error));
    return notFound;
  }
}

// One chunk of the decrypted content, through the same range-capable URL
// the timeline plays video from.
export async function readAttachment({
  offset,
  length,
  ...target
}: AttachmentsReadParamsType): Promise<ServiceResultType> {
  const attachment = await findAttachment(target);
  if (!attachment?.path) {
    return notFound;
  }
  const size = attachment.size ?? 0;
  if (offset > size) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  try {
    const response = await fetch(getLocalAttachmentUrl(attachment), {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    });
    if (!response.ok || !response.body) {
      return notFound;
    }
    // A server that ignored the range sends everything from the start.
    let skip = offset > 0 && response.status !== 206 ? offset : 0;
    const chunks = new Array<Uint8Array<ArrayBuffer>>();
    let total = 0;
    const reader = response.body.getReader();
    while (total < length) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      let chunk = value;
      if (skip > 0) {
        const dropped = Math.min(skip, chunk.byteLength);
        skip -= dropped;
        chunk = chunk.subarray(dropped);
      }
      const wanted = Math.min(chunk.byteLength, length - total);
      chunks.push(chunk.subarray(0, wanted));
      total += wanted;
    }
    drop(reader.cancel());
    const value: AttachmentsReadResultType = {
      contentType: attachment.contentType,
      size,
      offset,
      data: Buffer.concat(chunks).toString('base64'),
    };
    return { ok: true, value };
  } catch (error) {
    log.warn('readAttachment failed', Errors.toLogFormat(error));
    return notFound;
  }
}

// Same as clicking a not-yet-downloaded attachment in the timeline.
export async function downloadAttachments({
  messageId,
}: AttachmentsDownloadParamsType): Promise<ServiceResultType> {
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return notFound;
  }
  const dto = toMessageDTO(message, getDtoContext());
  if (!dto || (dto.attachments.length === 0 && !dto.sticker)) {
    return notFound;
  }
  window.reduxActions.conversations.kickOffAttachmentDownload({ messageId });
  return { ok: true, value: {} };
}

function withSkinTone(parent: Emoji.Parent): string {
  const skinTone =
    getEmojiSkinToneDefault(window.reduxStore.getState()) ??
    Emoji.SkinTone.None;
  return Emoji.getVariant(parent, skinTone);
}

export function getPreferredReactions(): ServiceResultType {
  const state = window.reduxStore.getState();
  const value: ReactionsGetPreferredResultType = {
    emoji: getPreferredReactionEmoji(state),
    recent: state.emojis.recentEmojis.map(parent => withSkinTone(parent)),
  };
  return { ok: true, value };
}

export function markEmojiUsed({
  emoji,
}: EmojiMarkUsedParamsType): ServiceResultType {
  if (!Emoji.isEmoji(emoji)) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const variant: Emoji.Variant = Emoji.isSkinToneVariant(emoji)
    ? emoji
    : Emoji.getDefaultVariant(Emoji.getParent(emoji));
  window.reduxActions.emojis.onUseEmoji({ emoji: variant });
  return { ok: true, value: {} };
}

// Signal's full emoji picker: its categories and order, its short names.
export function getEmojiCatalog(): ServiceResultType {
  const categories = Object.values(Emoji.Category).map(id => ({
    id,
    emoji: Emoji.getCategoryParents(id).map(
      parent => [withSkinTone(parent), Emoji.getDisplayLabel(parent)] as const
    ),
  }));
  const value: EmojiGetCatalogResultType = { categories };
  return { ok: true, value };
}

// Reacts exactly as Signal's reaction bar does. Refused wherever sending a
// message would be (blocked, message request, safety number...), since a
// reaction is a message and Signal would otherwise accept the request.
export async function react({
  messageId,
  emoji,
  remove = false,
}: MessagesReactParamsType): Promise<ServiceResultType> {
  if (!Emoji.isEmoji(emoji)) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const message = await loadMessage(messageId);
  if (!message) {
    return notFound;
  }
  const model = getListedConversation(message.conversationId);
  if (!model) {
    return notFound;
  }
  const dto = toMessageDTO(message, getDtoContext());
  if (!dto || dto.kind === 'deleted' || dto.kind === 'unsupported') {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }

  const reason = await getSendBlockReason(model, emoji);
  if (reason) {
    log.info(`react: refused (${reason})`);
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }

  const variant: Emoji.Variant = Emoji.isSkinToneVariant(emoji)
    ? emoji
    : Emoji.getDefaultVariant(Emoji.getParent(emoji));
  await enqueueReactionForSend({ messageId, emoji: variant, remove });
  // As Signal's picker does for anything beyond the quick-reaction bar:
  // it goes into the recently used list.
  const bar = getPreferredReactionEmoji(window.reduxStore.getState());
  if (!remove && !bar.some(item => item === emoji)) {
    window.reduxActions.emojis.onUseEmoji({ emoji: variant });
  }
  return { ok: true, value: {} };
}

// Edits as Signal's composer does, keeping the message's quote. The body
// replaces the old one as plain text.
export async function editMessage({
  messageId,
  body,
  mentions,
}: MessagesEditParamsType): Promise<ServiceResultType> {
  const message = await loadMessage(messageId);
  if (!message) {
    return notFound;
  }
  const model = getListedConversation(message.conversationId);
  if (!model) {
    return notFound;
  }
  if (!getDtoContext().getActions(message).canEdit) {
    return { ok: false, code: ErrorCode.PreconditionFailed };
  }
  const bodyRanges = toMentionRanges(model, body, mentions);
  if (!bodyRanges) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const reason = await getSendBlockReason(model, body);
  if (reason) {
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }
  await sendEditedMessage(model.id, {
    body,
    bodyRanges,
    preview: [],
    quoteSentAt: message.quote?.id ?? undefined,
    quoteAuthorAci: message.quote?.authorAci,
    targetMessageId: messageId,
  });
  return { ok: true, value: {} };
}

// Delete for me (this device and linked devices) or for everyone, as the
// message menu offers them.
export async function deleteMessage({
  messageId,
  forEveryone,
}: MessagesDeleteParamsType): Promise<ServiceResultType> {
  const message = await loadMessage(messageId);
  if (!message) {
    return notFound;
  }
  const model = getListedConversation(message.conversationId);
  if (!model) {
    return notFound;
  }
  if (forEveryone) {
    if (!getDtoContext().getActions(message).canDeleteForEveryone) {
      return { ok: false, code: ErrorCode.PreconditionFailed };
    }
    await sendDeleteForEveryoneMessage(model.attributes, {
      id: message.id,
      timestamp: getMessageSentTimestamp(message, { log }),
    });
  } else {
    window.reduxActions.conversations.deleteMessages({
      conversationId: model.id,
      messageIds: [message.id],
    });
  }
  return { ok: true, value: {} };
}
