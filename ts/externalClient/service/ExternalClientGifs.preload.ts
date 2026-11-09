// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import {
  fetchGiphyFile,
  fetchGiphySearch,
  fetchGiphyTrending,
} from '../../state/smart/fun/giphy.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import { isGiphyCdnUrl } from '../../util/giphy.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  AttachmentsReadResultType,
  GifsReadParamsType,
  GifsSearchParamsType,
  GifsSearchResultType,
} from '../protocol.std.ts';
import { ErrorCode, GIFS_PAGE_SIZE } from '../protocol.std.ts';

// Fork-only (decision F54): Signal's GIF picker, through the same Giphy
// calls and Signal proxy its composer uses.

const log = createLogger('ExternalClientGifs');

// Files read in chunks stay here for a while; a picker page holds 30
// previews and a send reads one original.
const CACHE_SIZE = 64;
const CACHE_MS = 10 * 60 * 1000;

type CachedType = {
  bytes: Promise<Uint8Array>;
  expiresAt: number;
};
const cache = new Map<string, CachedType>();

function readGif(url: string): Promise<Uint8Array> {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  const hit = cache.get(url);
  if (hit) {
    // Most recently used last.
    cache.delete(url);
    cache.set(url, hit);
    return hit.bytes;
  }
  const bytes = fetchGiphyFile(url).then(
    async blob => new Uint8Array(await blob.arrayBuffer())
  );
  bytes.catch(() => cache.delete(url));
  cache.set(url, { bytes, expiresAt: now + CACHE_MS });
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return bytes;
}

export async function searchGifs({
  query,
  offset,
}: GifsSearchParamsType): Promise<ServiceResultType> {
  const q = query?.trim() ?? '';
  try {
    const results = q
      ? await fetchGiphySearch(q, GIFS_PAGE_SIZE, offset ?? null)
      : await fetchGiphyTrending(GIFS_PAGE_SIZE, offset ?? null);
    const value: GifsSearchResultType = {
      next: results.next,
      gifs: results.gifs.map(gif => ({
        id: gif.id,
        title: gif.title,
        description: gif.description,
        preview: gif.previewMedia,
        original: gif.attachmentMedia,
      })),
    };
    return { ok: true, value };
  } catch (error) {
    log.warn('searchGifs failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
}

export async function readGifFile({
  url,
  offset,
  length,
}: GifsReadParamsType): Promise<ServiceResultType> {
  if (!isGiphyCdnUrl(url)) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readGif(url);
  } catch (error) {
    log.warn('readGifFile failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  if (offset > bytes.byteLength) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const value: AttachmentsReadResultType = {
    contentType: 'video/mp4',
    size: bytes.byteLength,
    offset,
    data: Buffer.from(bytes.subarray(offset, offset + length)).toString(
      'base64'
    ),
  };
  return { ok: true, value };
}
