// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import {
  getInstalledFavoriteStickers,
  getInstalledStickerPacks,
  getRecentStickers,
} from '../../state/selectors/stickers.std.ts';
import { isFavoriteStickersEnabled } from '../../util/stickers.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import { getSticker, getStickerPack } from '../../types/Stickers.preload.ts';
import { makeQuote } from '../../util/makeQuote.preload.ts';
import {
  AttachmentDisposition,
  getLocalAttachmentUrl,
} from '../../util/getLocalAttachmentUrl.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  AttachmentsGetThumbnailResultType,
  MessagesSendStickerParamsType,
  StickersGetImageParamsType,
  StickersGetPacksResultType,
  StickersSetFavoriteParamsType,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import { renderImage } from './ExternalClientExtras.preload.ts';
import {
  findQuotable,
  getSendBlockReason,
} from './ExternalClientSend.preload.ts';
import { getListedConversation } from './serviceHelpers.preload.ts';

// Fork addition: Signal's sticker picker for external clients (decision F10).

const log = createLogger('ExternalClientStickers');

const notFound = { ok: false, code: ErrorCode.NotFound } as const;
const PICKER_SIZE_PX = 160;

// The picker's tabs: installed packs in Signal's order, and Recently used.
export function getStickerPacks(): ServiceResultType {
  const state = window.reduxStore.getState();
  const value: StickersGetPacksResultType = {
    packs: getInstalledStickerPacks(state).map(pack => ({
      id: pack.id,
      title: pack.title,
      author: pack.author,
      coverStickerId: pack.cover?.id ?? null,
      stickers: pack.stickers.map(sticker => ({
        id: sticker.id,
        emoji: sticker.emoji ?? null,
      })),
    })),
    recents: getRecentStickers(state).map(sticker => ({
      packId: sticker.packId,
      stickerId: sticker.id,
      emoji: sticker.emoji ?? null,
    })),
    favorites: getInstalledFavoriteStickers(state).map(sticker => ({
      packId: sticker.packId,
      stickerId: sticker.id,
      emoji: sticker.emoji ?? null,
    })),
    favoritesEnabled: isFavoriteStickersEnabled(),
  };
  return { ok: true, value };
}

// Signal's Add to / Remove from favorites (StickerPreviewModal), which syncs
// through storage service. The pack must be one Signal knows, as there; it
// runs on its own and shows Signal's own toast.
export function setStickerFavorite({
  packId,
  stickerId,
  favorite,
}: StickersSetFavoriteParamsType): ServiceResultType {
  if (!isFavoriteStickersEnabled()) {
    return { ok: false, code: ErrorCode.PreconditionFailed };
  }
  if (!getStickerPack(packId) || !getSticker(packId, stickerId)) {
    return notFound;
  }
  window.reduxActions.stickers.markStickerAsFavorite(
    { packId, stickerId },
    favorite
  );
  return { ok: true, value: {} };
}

// Only stickers the picker offers: from installed packs, or recently used.
// A pack's cover may be a picture of its own, shown only as its tab.
function findPickerSticker(
  packId: string,
  stickerId: number,
  { allowCover }: { allowCover: boolean }
) {
  const pack = getStickerPack(packId);
  const sticker = getSticker(packId, stickerId);
  if (!pack || !sticker?.path) {
    return undefined;
  }
  if (
    sticker.isCoverOnly &&
    !(allowCover && pack.coverStickerId === stickerId)
  ) {
    return undefined;
  }
  const state = window.reduxStore.getState();
  const offered =
    pack.status === 'installed' ||
    state.stickers.recentStickers.some(
      recent => recent.packId === packId && recent.stickerId === stickerId
    ) ||
    state.stickers.favoriteStickers.some(
      fav => fav.packId === packId && fav.stickerId === stickerId
    );
  return offered ? { pack, sticker } : undefined;
}

export async function getStickerImage({
  packId,
  stickerId,
  width,
}: StickersGetImageParamsType): Promise<ServiceResultType> {
  const found = findPickerSticker(packId, stickerId, { allowCover: true });
  if (!found) {
    return notFound;
  }
  try {
    const url = getLocalAttachmentUrl(found.sticker, {
      disposition: AttachmentDisposition.Sticker,
    });
    const image = await renderImage(url, { fit: width ?? PICKER_SIZE_PX });
    if (!image) {
      return notFound;
    }
    const value: AttachmentsGetThumbnailResultType = image;
    return { ok: true, value };
  } catch (error) {
    log.warn('getStickerImage failed', Errors.toLogFormat(error));
    return notFound;
  }
}

// Signal's own sticker send (which also moves it to Recently used), refused
// where the composer would refuse (decision D11).
export async function sendSticker({
  conversationId,
  packId,
  stickerId,
  quoteMessageId,
}: MessagesSendStickerParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return notFound;
  }
  if (!findPickerSticker(packId, stickerId, { allowCover: false })) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  // Sticker replies (decision F28): Signal's own composer does this behind
  // its desktop.stickerReply.send flag, with the same quote.
  const quoted = await findQuotable(quoteMessageId, model);
  if (quoted === 'invalid') {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const reason = await getSendBlockReason(model, '');
  if (reason) {
    log.info(`sendSticker: refused (${reason})`);
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }
  await model.sendStickerMessage(
    packId,
    stickerId,
    quoted ? { quote: await makeQuote(quoted) } : undefined
  );
  return { ok: true, value: {} };
}
