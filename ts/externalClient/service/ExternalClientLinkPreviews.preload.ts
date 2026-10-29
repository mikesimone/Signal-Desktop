// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import * as Errors from '../../types/errors.std.ts';
import * as LinkPreview from '../../types/LinkPreview.std.ts';
import type { LinkPreviewType } from '../../types/message/LinkPreviews.std.ts';
import {
  getPreview,
  transferLinkPreviewDraftToDisk,
} from '../../services/LinkPreview.preload.ts';
import { getLinkPreviewSetting } from '../../util/Settings.preload.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ComposerLinkPreviewDTO,
  LinkPreviewsFetchParamsType,
  LinkPreviewsFetchResultType,
} from '../protocol.std.ts';
import { renderImageBlob } from './ExternalClientExtras.preload.ts';

const log = createLogger('ExternalClientLinkPreviews');

type LinkPreviewResult = NonNullable<Awaited<ReturnType<typeof getPreview>>>;

// Fork addition (decision F27): link previews as Signal's composer makes
// them. Signal fetches the page and its image with its own fetcher (the same
// code and settings as its composer); the result is kept here briefly so
// the send attaches exactly what the client showed.
const CACHE_SIZE = 20;
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const PREVIEW_IMAGE_PX = 400;

type CachedType = Readonly<{
  at: number;
  result: Promise<LinkPreviewResult | null>;
}>;
const cache = new Map<string, CachedType>();

async function fetchPreview(url: string): Promise<LinkPreviewResult | null> {
  try {
    const preview = await getPreview(
      url,
      AbortSignal.timeout(FETCH_TIMEOUT_MS)
    );
    // Signal shows a preview only with a title or an image.
    return preview && (preview.title || preview.image) ? preview : null;
  } catch (error) {
    log.warn('fetchPreview failed', Errors.toLogFormat(error));
    return null;
  }
}

async function loadPreview(url: string): Promise<LinkPreviewResult | null> {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.at < CACHE_MS) {
    return cached.result;
  }
  const result = fetchPreview(url);
  cache.delete(url);
  cache.set(url, { at: now, result });
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  const preview = await result;
  // A failure is not remembered, so the next try fetches again.
  if (!preview && cache.get(url)?.result === result) {
    cache.delete(url);
  }
  return preview;
}

async function toPreviewImage(
  preview: LinkPreviewResult
): Promise<ComposerLinkPreviewDTO['image']> {
  const { image } = preview;
  if (!image || image.pending || !image.data) {
    return null;
  }
  try {
    return (
      (await renderImageBlob(
        new Blob([image.data], { type: image.contentType }),
        { fit: PREVIEW_IMAGE_PX }
      )) ?? null
    );
  } catch (error) {
    log.warn('toPreviewImage failed', Errors.toLogFormat(error));
    return null;
  }
}

export async function fetchLinkPreview({
  text,
  exclude = [],
}: LinkPreviewsFetchParamsType): Promise<ServiceResultType> {
  const none: ServiceResultType = {
    ok: true,
    value: { preview: null } satisfies LinkPreviewsFetchResultType,
  };
  if (!getLinkPreviewSetting()) {
    return none;
  }
  const url = LinkPreview.findLinks(text).find(
    link => LinkPreview.shouldPreviewHref(link) && !exclude.includes(link)
  );
  if (!url) {
    return none;
  }
  const preview = await loadPreview(url);
  if (!preview) {
    return none;
  }
  const value: LinkPreviewsFetchResultType = {
    preview: {
      url,
      title: preview.title ?? null,
      description: preview.description ?? null,
      domain: LinkPreview.getDomain(url),
      date: preview.date ?? null,
      image: await toPreviewImage(preview),
    },
  };
  return { ok: true, value };
}

// What messages.sendText attaches for `linkPreviewUrl`: as Signal's
// getLinkPreviewForSend, nothing when previews are off or the link is no
// longer in the message.
export async function getLinkPreviewsForSend(
  url: string | undefined,
  body: string
): Promise<Array<LinkPreviewType>> {
  if (
    !url ||
    !getLinkPreviewSetting() ||
    !LinkPreview.shouldPreviewHref(url) ||
    !LinkPreview.findLinks(body).includes(url)
  ) {
    return [];
  }
  const preview = await loadPreview(url);
  return preview
    ? [
        await transferLinkPreviewDraftToDisk({
          ...preview,
          domain: undefined,
          isStickerPack: false,
          isCallLink: false,
          callLinkRoomId: undefined,
        }),
      ]
    : [];
}
