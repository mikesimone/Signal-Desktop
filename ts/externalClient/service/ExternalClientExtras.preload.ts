// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import { Emoji } from '../../axo/emoji.std.ts';
import { enqueueReactionForSend } from '../../reactions/enqueueReactionForSend.preload.ts';
import { getPreferredReactionEmoji } from '../../state/selectors/items.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import { getLocalAvatarUrl } from '../../util/avatarUtils.preload.ts';
import { isSignalConversation } from '../../util/isSignalConversation.dom.ts';
import { getAvatarVersion } from '../conversationDto.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import type {
  ConversationsGetAvatarParamsType,
  ConversationsGetAvatarResultType,
  MessagesReactParamsType,
  ReactionsGetPreferredResultType,
} from '../protocol.std.ts';
import { AVATAR_SIZE_PX, ErrorCode } from '../protocol.std.ts';
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
    const response = await fetch(url);
    if (!response.ok) {
      return notFound;
    }
    const bitmap = await createImageBitmap(await response.blob());
    // Cover-crop to a square, as Signal's round avatars do.
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(AVATAR_SIZE_PX, AVATAR_SIZE_PX);
    const context = canvas.getContext('2d');
    if (!context || side === 0) {
      bitmap.close();
      return notFound;
    }
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE_PX,
      AVATAR_SIZE_PX
    );
    bitmap.close();
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    if (blob.type !== 'image/webp') {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const value: ConversationsGetAvatarResultType = {
      avatarVersion,
      contentType: blob.type === 'image/webp' ? 'image/webp' : 'image/png',
      data: Buffer.from(bytes).toString('base64'),
    };
    return { ok: true, value };
  } catch (error) {
    log.warn('getAvatar: could not read avatar', Errors.toLogFormat(error));
    return notFound;
  }
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
