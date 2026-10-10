// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import { drop } from '../../util/drop.std.ts';
import { Emoji } from '../../axo/emoji.std.ts';
import { enqueueReactionForSend } from '../../reactions/enqueueReactionForSend.preload.ts';
import { getPreferredReactionEmoji } from '../../state/selectors/items.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import type { AttachmentType } from '../../types/Attachment.std.ts';
import { isImageAttachment } from '../../util/Attachment.std.ts';
import { getLocalAttachmentUrl } from '../../util/getLocalAttachmentUrl.std.ts';
import { getLocalAvatarUrl } from '../../util/avatarUtils.preload.ts';
import { isSignalConversation } from '../../util/isSignalConversation.dom.ts';
import { getAvatarVersion } from '../conversationDto.std.ts';
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
  MessagesReactParamsType,
  ReactionsGetPreferredResultType,
} from '../protocol.std.ts';
import {
  AVATAR_SIZE_PX,
  ErrorCode,
  THUMBNAIL_SIZE_PX,
} from '../protocol.std.ts';
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
async function renderImage(
  url: string,
  size: Readonly<{ square: number } | { fit: number }>
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
      const scale = Math.min(1, size.fit / Math.max(width, height));
      dw = Math.max(1, Math.round(width * scale));
      dh = Math.max(1, Math.round(height * scale));
    }
    const canvas = new OffscreenCanvas(dw, dh);
    const context = canvas.getContext('2d');
    if (!context) {
      return undefined;
    }
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    if (blob.type !== 'image/webp') {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      contentType: blob.type === 'image/webp' ? 'image/webp' : 'image/png',
      width: dw,
      height: dh,
      data: Buffer.from(bytes).toString('base64'),
    };
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
}: AttachmentsGetThumbnailParamsType): Promise<AttachmentType | undefined> {
  if ((index === undefined) === (sticker === undefined)) {
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
  let source: Pick<AttachmentType, 'path'> | undefined;
  if (attachment.thumbnail?.path) {
    source = attachment.thumbnail;
  } else if (attachment.screenshot?.path) {
    source = attachment.screenshot;
  } else if (
    (isImageAttachment(attachment) || params.sticker) &&
    attachment.path
  ) {
    source = attachment;
  }
  if (!source) {
    return notFound;
  }
  try {
    const image = await renderImage(getLocalAttachmentUrl(source), {
      fit: THUMBNAIL_SIZE_PX,
    });
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

export function getPreferredReactions(): ServiceResultType {
  const value: ReactionsGetPreferredResultType = {
    emoji: getPreferredReactionEmoji(window.reduxStore.getState()),
  };
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

  await enqueueReactionForSend({
    messageId,
    emoji: Emoji.isSkinToneVariant(emoji)
      ? emoji
      : Emoji.getDefaultVariant(Emoji.getParent(emoji)),
    remove,
  });
  return { ok: true, value: {} };
}
