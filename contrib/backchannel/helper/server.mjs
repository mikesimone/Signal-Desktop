// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The local web side of Backchannel: a small HTTP server on 127.0.0.1 that
// serves the chat page (in Rambox or any browser), a JSON API over the bridge, and a
// Server-Sent Events stream of live updates.
//
// Anything on this computer can open a loopback port, including web pages in
// a browser, so every request must:
//   - carry the secret token as its first path segment,
//   - name this server in Host (stops DNS rebinding),
//   - if it has an Origin, come from this server (stops other pages),
//   - for POST, send application/json, or application/octet-stream for file
//     uploads (both force a CORS preflight, which this server never
//     approves).

import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const MAX_BODY_BYTES = 128 * 1024;
// Signal's limit for a new profile photo (profile.setAvatar).
const MAX_PROFILE_PHOTO_BYTES = 600 * 1024;
const MAX_EVENT_STREAMS = 8;
// Signal answers at most 16 requests at once per app; leave room for the
// page's own calls while a chat list full of photos loads.
const MAX_AVATAR_CALLS = 4;
const MAX_CACHED_AVATARS = 2000;
// Must not exceed the bridge's MAX_ATTACHMENT_CHUNK_BYTES.
const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

// "bytes=a-b" or "bytes=a-" within size, else null (serve everything).
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) {
    return null;
  }
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

// Only these types are shown inline; anything else is a download, so a file
// from a chat can never run as a page on this origin.
const INLINE_TYPES =
  /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/[a-z0-9.+-]+)$/i;

// Signal's own fonts: its emoji set and Inter. Served from fontDir, which
// holds Signal's fonts/ folder layout (the repository's, or a copy).
const FONT_FILES = {
  'fonts/emoji.woff2': 'emoji.woff2',
  'fonts/Inter-Regular.woff2': 'inter-v3.19/Inter-Regular.woff2',
  'fonts/Inter-Medium.woff2': 'inter-v3.19/Inter-Medium.woff2',
  'fonts/Inter-SemiBold.woff2': 'inter-v3.19/Inter-SemiBold.woff2',
};

// Signal's quick-reaction defaults, for a Signal that cannot report the
// user's own.
const DEFAULT_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢'];

const STATIC_FILES = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'app.js': ['app.js', 'text/javascript; charset=utf-8'],
  'app.css': ['app.css', 'text/css; charset=utf-8'],
  'icon.svg': ['icon.svg', 'image/svg+xml'],
  // Signal's own message status icons (images/icons/v3).
  ...Object.fromEntries(
    ['sending', 'sent', 'delivered', 'read', 'failed'].map(name => [
      `status/${name}.svg`,
      [`status/${name}.svg`, 'image/svg+xml'],
    ])
  ),
  // Signal's notification sound.
  'sounds/notification.ogg': ['sounds/notification.ogg', 'audio/ogg'],
  // Signal's voice note encoder (bundles/workers/mp3Encoder.js), copied in
  // by the Backchannel image; without it the page can't record.
  'mp3Encoder.js': ['mp3Encoder.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; " +
    "base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function tokenMatches(given, token) {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// The origins the page may be served from: the loopback address by default,
// plus any given with --origin (e.g. an HTTPS name behind a reverse proxy).
export function allowedOrigins(port, extra = []) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra];
}

// Returns null when the request may proceed, else [status, reason].
export function checkRequest(req, { origins, token }) {
  const hosts = origins.map(o => new URL(o).host);
  if (!hosts.includes(req.headers.host ?? '')) {
    return [421, 'wrong host'];
  }
  const { origin } = req.headers;
  if (origin !== undefined && !origins.includes(origin)) {
    return [403, 'wrong origin'];
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (
    fetchSite !== undefined &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  ) {
    return [403, 'cross-site request'];
  }
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const [, first] = path.split('/');
  if (!tokenMatches(first, token)) {
    return [404, 'not found'];
  }
  if (req.method === 'POST') {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const upload =
      path.endsWith('/api/upload') ||
      path.endsWith('/api/scheduleFile') ||
      path.endsWith('/api/profilePhoto') ||
      path.endsWith('/api/groups') ||
      path.endsWith('/api/groupInfo');
    if (type !== (upload ? 'application/octet-stream' : 'application/json')) {
      return [415, 'wrong content type'];
    }
  } else if (req.method !== 'GET') {
    return [405, 'method not allowed'];
  }
  return null;
}

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

// Null when the body is over `max`; the rest is drained, so the answer
// still reaches the page.
async function readBytes(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= max) {
      chunks.push(chunk);
    }
  }
  return size > max ? null : Buffer.concat(chunks);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// store: Store (see store.mjs); bridge: Bridge.
export function createWebServer({
  port,
  bindAddress = '127.0.0.1',
  origins = allowedOrigins(port),
  token,
  publicDir,
  fontDir,
  getLargeEmojiFont = async () => null,
  store,
  bridge,
  privateReplies = null,
  scheduled = null,
  log,
}) {
  const streams = new Set();
  // conversationId -> { avatarVersion, contentType, bytes }
  const avatars = new Map();
  const avatarLoads = new Map();
  let avatarCalls = 0;
  const avatarQueue = [];
  let emojiCatalog = null;

  async function withAvatarSlot(task) {
    if (avatarCalls >= MAX_AVATAR_CALLS) {
      await new Promise(resolve => avatarQueue.push(resolve));
    }
    avatarCalls += 1;
    try {
      return await task();
    } finally {
      avatarCalls -= 1;
      avatarQueue.shift()?.();
    }
  }

  // Resolves to the photo, or null when there is none.
  function loadAvatar(conversationId, version) {
    const cached = avatars.get(conversationId);
    if (cached && (!version || cached.avatarVersion === version)) {
      return Promise.resolve(cached);
    }
    const key = `${conversationId}:${version}`;
    let loading = avatarLoads.get(key);
    if (!loading) {
      loading = withAvatarSlot(() =>
        bridge.call('conversations.getAvatar', { conversationId })
      )
        .then(result => {
          const entry = {
            avatarVersion: result.avatarVersion,
            contentType: result.contentType,
            bytes: Buffer.from(result.data, 'base64'),
          };
          avatars.delete(conversationId);
          avatars.set(conversationId, entry);
          if (avatars.size > MAX_CACHED_AVATARS) {
            avatars.delete(avatars.keys().next().value);
          }
          return entry;
        })
        .catch(error => {
          if (error.code === 'NOT_FOUND') {
            return null;
          }
          throw error;
        })
        .finally(() => avatarLoads.delete(key));
      avatarLoads.set(key, loading);
    }
    return loading;
  }

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      res.write(payload);
    }
  }

  function updateNotificationHandoff() {
    bridge.setNotificationsWanted(streams.size > 0).catch(() => {});
  }

  function attachmentTarget(url) {
    const messageId = url.searchParams.get('messageId');
    if (url.searchParams.get('sticker') === '1') {
      return { messageId, sticker: true };
    }
    if (url.searchParams.get('quote') === '1') {
      return { messageId, quote: true };
    }
    if (url.searchParams.has('preview')) {
      return { messageId, preview: Number(url.searchParams.get('preview')) };
    }
    return { messageId, index: Number(url.searchParams.get('index') ?? 0) };
  }

  // Passes a file from the page to Signal in chunks, reading the request
  // only as fast as Signal takes it.
  async function uploadAttachment(req, res, url) {
    const size = Number(req.headers['content-length']);
    const contentType = url.searchParams.get('contentType') ?? '';
    const fileName = url.searchParams.get('name') || undefined;
    let voiceNote;
    try {
      voiceNote = JSON.parse(url.searchParams.get('voiceNote') ?? 'null');
    } catch {
      voiceNote = undefined;
    }
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      contentType === '' ||
      voiceNote === undefined
    ) {
      sendJson(res, 400, { error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const uploadId = await uploadStream(req, {
      size,
      contentType,
      fileName,
      voiceNote,
    });
    if (!uploadId) {
      sendJson(res, 400, { error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    sendJson(res, 200, { uploadId });
  }

  // Hands a stream of `size` bytes to Signal as an upload; null if the
  // stream wasn't that long.
  async function uploadStream(
    stream,
    { size, contentType, fileName, voiceNote }
  ) {
    const { uploadId } = await bridge.call('attachments.uploadBegin', {
      contentType,
      size,
      ...(fileName ? { fileName: fileName.slice(0, 255) } : {}),
      ...(voiceNote ? { voiceNote } : {}),
    });
    let offset = 0;
    let pending = [];
    let pendingBytes = 0;
    const flush = async () => {
      const data = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      for (let at = 0; at < data.length; at += ATTACHMENT_CHUNK_BYTES) {
        const chunk = data.subarray(at, at + ATTACHMENT_CHUNK_BYTES);
        // oxlint-disable-next-line no-await-in-loop
        await bridge.call('attachments.uploadChunk', {
          uploadId,
          offset,
          data: chunk.toString('base64'),
        });
        offset += chunk.length;
      }
    };
    for await (const chunk of stream) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= ATTACHMENT_CHUNK_BYTES) {
        await flush();
      }
    }
    await flush();
    return offset === size ? uploadId : null;
  }

  // Streams decrypted attachment content from Signal in chunks, honoring
  // Range so video can seek.
  async function streamAttachment(req, res, url) {
    const target = attachmentTarget(url);
    const first = await bridge.call('attachments.read', {
      ...target,
      offset: 0,
      length: 1,
    });
    const { size } = first;
    const type = first.contentType || 'application/octet-stream';
    const inline =
      INLINE_TYPES.test(type) && url.searchParams.get('download') !== '1';
    const name = (url.searchParams.get('name') ?? 'attachment').replace(
      /[^\p{L}\p{N} ._()-]/gu,
      '_'
    );
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        ...SECURITY_HEADERS,
        'Content-Range': `bytes */${size}`,
      });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    res.writeHead(range ? 206 : 200, {
      ...SECURITY_HEADERS,
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Length': String(Math.max(0, end - start + 1)),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=3600',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    let offset = start;
    while (offset <= end && !closed) {
      const length = Math.min(ATTACHMENT_CHUNK_BYTES, end - offset + 1);
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await bridge.call('attachments.read', {
        ...target,
        offset,
        length,
      });
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.length === 0) {
        break;
      }
      if (!res.write(bytes)) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
      }
      offset += bytes.length;
    }
    res.end();
  }

  // Scheduled messages (decision F29), kept by the helper.
  async function handleScheduled(req, res, route, url) {
    if (req.method === 'GET' && route === 'api/scheduled') {
      sendJson(res, 200, {
        items: scheduled.list(url.searchParams.get('conversationId') ?? ''),
        counts: scheduled.counts(),
      });
      return;
    }
    if (req.method === 'POST' && route === 'api/scheduleFile') {
      const file = await scheduled.saveFile(req, {
        size: Number(req.headers['content-length']),
        contentType: url.searchParams.get('contentType') ?? '',
        fileName: url.searchParams.get('name') || null,
      });
      sendJson(res, 200, file);
      return;
    }
    if (req.method === 'POST' && route === 'api/schedule') {
      const {
        conversationId,
        sendAt,
        body,
        mentions,
        formatting,
        quoteMessageId,
        linkPreviewUrl,
        files,
      } = await readJson(req);
      // Signal checks the chat again when it sends.
      if (!store.snapshot().conversations.some(c => c.id === conversationId)) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
        return;
      }
      const item = scheduled.add({
        conversationId,
        sendAt,
        body: body ?? '',
        mentions,
        formatting,
        quoteMessageId,
        linkPreviewUrl,
        files,
      });
      sendJson(res, 200, { item });
      return;
    }
    if (req.method === 'POST' && route === 'api/scheduled/update') {
      const { id, sendAt, body } = await readJson(req);
      const item = scheduled.update(id, { sendAt, body });
      sendJson(
        res,
        item ? 200 : 404,
        item ? { item } : { error: { code: 'NOT_FOUND' } }
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/scheduled/delete') {
      const { id } = await readJson(req);
      sendJson(res, 200, { removed: scheduled.remove(id) });
      return;
    }
    if (req.method === 'POST' && route === 'api/scheduled/sendNow') {
      const { id } = await readJson(req);
      const found = scheduled.sendNow(id);
      if (found) {
        await scheduled.run(scheduled.ready);
      }
      sendJson(
        res,
        found ? 200 : 404,
        found ? {} : { error: { code: 'NOT_FOUND' } }
      );
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
  }

  async function handleApi(req, res, route, url) {
    if (req.method === 'GET' && route === 'api/state') {
      sendJson(res, 200, {
        ...store.snapshot(),
        capabilities: bridge.capabilities,
      });
      return;
    }
    if (req.method === 'GET' && route === 'api/avatar') {
      const conversationId = url.searchParams.get('conversationId');
      const version = url.searchParams.get('v') ?? '';
      const avatar = await loadAvatar(conversationId, version);
      if (!avatar) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
        return;
      }
      // The URL names the version, so a matching photo never changes.
      const immutable = version !== '' && avatar.avatarVersion === version;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': avatar.contentType,
        ...(immutable
          ? { 'Cache-Control': 'private, max-age=604800, immutable' }
          : {}),
      });
      res.end(avatar.bytes);
      return;
    }
    if (req.method === 'GET' && route === 'api/thumbnail') {
      const target = attachmentTarget(url);
      const width = Number(url.searchParams.get('width'));
      const thumb = await bridge.call('attachments.getThumbnail', {
        ...target,
        // Drawn at this many device pixels wide; Signal clamps it.
        ...(Number.isInteger(width) && width >= 32
          ? { width: Math.min(width, 1600) }
          : {}),
      });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': thumb.contentType,
        'Cache-Control': 'private, max-age=3600',
      });
      res.end(Buffer.from(thumb.data, 'base64'));
      return;
    }
    if (req.method === 'GET' && route === 'api/stickers') {
      sendJson(res, 200, await bridge.call('stickers.getPacks', {}));
      return;
    }
    if (req.method === 'GET' && route === 'api/stickerImage') {
      const width = Number(url.searchParams.get('width'));
      const image = await bridge.call('stickers.getImage', {
        packId: url.searchParams.get('packId') ?? '',
        stickerId: Number(url.searchParams.get('stickerId')),
        ...(Number.isInteger(width) && width >= 16
          ? { width: Math.min(width, 512) }
          : {}),
      });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': image.contentType,
        // A sticker never changes.
        'Cache-Control': 'private, max-age=604800, immutable',
      });
      res.end(Buffer.from(image.data, 'base64'));
      return;
    }
    if (req.method === 'POST' && route === 'api/sendSticker') {
      const { conversationId, packId, stickerId, quoteMessageId } =
        await readJson(req);
      const result = await bridge.call('messages.sendSticker', {
        conversationId,
        packId,
        stickerId,
        ...(quoteMessageId ? { quoteMessageId } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET' && route === 'api/attachment') {
      await streamAttachment(req, res, url);
      return;
    }
    if (req.method === 'POST' && route === 'api/download') {
      const { messageId } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('attachments.download', { messageId })
      );
      return;
    }
    if (req.method === 'GET' && route === 'api/reactions') {
      if (!bridge.capabilities.includes('messages.react')) {
        sendJson(res, 200, { emoji: DEFAULT_REACTIONS });
        return;
      }
      // Not cached: the recently used list changes as the user reacts.
      sendJson(res, 200, await bridge.call('reactions.getPreferred', {}));
      return;
    }
    if (req.method === 'POST' && route === 'api/emojiUsed') {
      const { emoji } = await readJson(req);
      sendJson(res, 200, await bridge.call('emoji.markUsed', { emoji }));
      return;
    }
    if (req.method === 'GET' && route === 'api/emoji') {
      if (!bridge.capabilities.includes('messages.react')) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
        return;
      }
      emojiCatalog ??= await bridge.call('emoji.getCatalog', {});
      sendJson(res, 200, emojiCatalog);
      return;
    }
    if (req.method === 'GET' && route === 'api/settings') {
      sendJson(res, 200, await bridge.call('settings.get', {}));
      return;
    }
    if (req.method === 'POST' && route === 'api/settings') {
      const { key, value } = await readJson(req);
      const result = await bridge.call('settings.set', { key, value });
      if (key === 'emojiSkinTone') {
        // The catalog comes in the default skin tone.
        emojiCatalog = null;
      }
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET' && route === 'api/details') {
      const conversationId = url.searchParams.get('conversationId');
      sendJson(
        res,
        200,
        await bridge.call('conversations.getDetails', { conversationId })
      );
      return;
    }
    if (req.method === 'GET' && route === 'api/search') {
      const query = url.searchParams.get('q') ?? '';
      const conversationId = url.searchParams.get('conversationId');
      sendJson(
        res,
        200,
        await bridge.call('messages.search', {
          query,
          ...(conversationId ? { conversationId } : {}),
          ...(url.searchParams.get('unread') === '1'
            ? { onlyUnread: true }
            : {}),
        })
      );
      return;
    }
    // Signal's "Safety number changed" dialog (decision F35).
    if (req.method === 'GET' && route === 'api/safetyNumbers') {
      sendJson(
        res,
        200,
        await bridge.call('safetyNumbers.changed', {
          conversationId: url.searchParams.get('conversationId'),
        })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/safetyNumbers/accept') {
      const { conversationId, contactIds } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('safetyNumbers.accept', {
          conversationId,
          contactIds,
        })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/contacts/sync') {
      sendJson(res, 200, await bridge.call('contacts.sync', {}));
      return;
    }
    if (req.method === 'GET' && route === 'api/chatFolders') {
      sendJson(res, 200, await bridge.call('chatFolders.list', {}));
      return;
    }
    if (req.method === 'POST' && route === 'api/conversation') {
      const { conversationId, change } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('conversations.update', { conversationId, change })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/typing') {
      const { conversationId, typing } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('conversations.setTyping', {
          conversationId,
          typing,
        })
      );
      return;
    }
    if (req.method === 'GET' && route === 'api/profile') {
      sendJson(res, 200, await bridge.call('profile.get', {}));
      return;
    }
    if (req.method === 'POST' && route === 'api/profile') {
      const { firstName, familyName, aboutText, aboutEmoji } =
        await readJson(req);
      const result = await bridge.call('profile.set', {
        firstName,
        familyName,
        aboutText,
        aboutEmoji,
      });
      sendJson(res, 200, result);
      return;
    }
    // Signal's compose button: contacts, finding people, new groups.
    if (req.method === 'GET' && route === 'api/contacts') {
      const forGroup = url.searchParams.get('forGroup') === '1';
      sendJson(
        res,
        200,
        await bridge.call('contacts.list', forGroup ? { forGroup } : {})
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/find') {
      const { query } = await readJson(req);
      sendJson(res, 200, await bridge.call('conversations.find', { query }));
      return;
    }
    if (req.method === 'POST' && route === 'api/open') {
      const { conversationId } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('conversations.open', { conversationId })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/groups') {
      // The group's details in the query; the body is its photo, if any.
      let group;
      try {
        group = JSON.parse(url.searchParams.get('group') ?? '');
      } catch {
        group = null;
      }
      const bytes = await readBytes(req, MAX_PROFILE_PHOTO_BYTES);
      if (!group || typeof group !== 'object' || !bytes) {
        sendJson(res, 400, { error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      const { name, memberIds, disappearingSeconds } = group;
      const result = await bridge.call('groups.create', {
        name,
        memberIds,
        ...(disappearingSeconds != null ? { disappearingSeconds } : {}),
        ...(bytes.length > 0 ? { avatar: bytes.toString('base64') } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    // Signal's group details page: one group change.
    if (req.method === 'POST' && route === 'api/group') {
      const { conversationId, change } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('groups.update', { conversationId, change })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/groupInfo') {
      // Name, description and photo in the query; the body is the new
      // photo when `photo` is 'set'. 'remove' removes it.
      let info;
      try {
        info = JSON.parse(url.searchParams.get('info') ?? '');
      } catch {
        info = null;
      }
      const bytes = await readBytes(req, MAX_PROFILE_PHOTO_BYTES);
      if (!info || typeof info !== 'object' || !bytes) {
        sendJson(res, 400, { error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      const { conversationId, name, description, photo } = info;
      if (photo === 'set' && bytes.length === 0) {
        sendJson(res, 400, { error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      const change = {
        action: 'setInfo',
        ...(name != null ? { name } : {}),
        ...(description != null ? { description } : {}),
        ...(photo === 'set' ? { avatar: bytes.toString('base64') } : {}),
        ...(photo === 'remove' ? { avatar: null } : {}),
      };
      sendJson(
        res,
        200,
        await bridge.call('groups.update', { conversationId, change })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/profilePhoto') {
      // An empty body removes the photo.
      const bytes = await readBytes(req, MAX_PROFILE_PHOTO_BYTES);
      if (!bytes) {
        sendJson(res, 413, { error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      const result = await bridge.call('profile.setAvatar', {
        data: bytes.length > 0 ? bytes.toString('base64') : null,
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/react') {
      const { messageId, emoji, remove } = await readJson(req);
      const result = await bridge.call('messages.react', {
        messageId,
        emoji,
        ...(remove ? { remove: true } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET' && route === 'api/members') {
      const conversationId = url.searchParams.get('conversationId');
      sendJson(
        res,
        200,
        await bridge.call('conversations.getMembers', { conversationId })
      );
      return;
    }
    if (req.method === 'GET' && route === 'api/media') {
      const cursor = url.searchParams.get('cursor');
      sendJson(
        res,
        200,
        await bridge.call('media.list', {
          conversationId: url.searchParams.get('conversationId'),
          kind: url.searchParams.get('kind'),
          limit: 60,
          ...(cursor ? { cursor } : {}),
        })
      );
      return;
    }
    if (req.method === 'GET' && route === 'api/messages') {
      const conversationId = url.searchParams.get('conversationId');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const newer = url.searchParams.get('newer') === '1';
      const result = await bridge.call('messages.list', {
        conversationId,
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(cursor && newer ? { newer: true } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/send') {
      const {
        conversationId,
        body,
        quoteMessageId,
        attachmentUploadIds,
        mentions,
        formatting,
        privateReplyFrom,
        linkPreviewUrl,
      } = await readJson(req);
      const result = await bridge.call('messages.sendText', {
        conversationId,
        body,
        ...(quoteMessageId ? { quoteMessageId } : {}),
        ...(mentions?.length ? { mentions } : {}),
        ...(formatting?.length ? { formatting } : {}),
        ...(attachmentUploadIds?.length ? { attachmentUploadIds } : {}),
        ...(typeof linkPreviewUrl === 'string' ? { linkPreviewUrl } : {}),
      });
      // "Reply privately": remember the link for the page (decision F23).
      if (
        privateReplies &&
        typeof privateReplyFrom === 'string' &&
        quoteMessageId &&
        result.message?.id
      ) {
        privateReplies.add({
          groupConversationId: privateReplyFrom,
          groupMessageId: quoteMessageId,
          dmConversationId: conversationId,
          replyMessageId: result.message.id,
        });
      }
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/linkPreview') {
      const { text, exclude } = await readJson(req);
      sendJson(
        res,
        200,
        await bridge.call('linkPreviews.fetch', {
          text,
          ...(Array.isArray(exclude) && exclude.length > 0
            ? { exclude: exclude.slice(0, 20) }
            : {}),
        })
      );
      return;
    }
    if (scheduled && route.startsWith('api/schedule')) {
      await handleScheduled(req, res, route, url);
      return;
    }
    if (req.method === 'GET' && route === 'api/privateReplies') {
      const conversationId = url.searchParams.get('conversationId') ?? '';
      sendJson(res, 200, {
        links: privateReplies?.forConversation(conversationId) ?? [],
      });
      return;
    }
    if (req.method === 'GET' && route === 'api/locateQuote') {
      const messageId = url.searchParams.get('messageId') ?? '';
      sendJson(
        res,
        200,
        await bridge.call('messages.locateQuote', { messageId })
      );
      return;
    }
    if (req.method === 'POST' && route === 'api/upload') {
      await uploadAttachment(req, res, url);
      return;
    }
    if (req.method === 'POST' && route === 'api/forward') {
      const { messageId, conversationIds, edit } = await readJson(req);
      const result = await bridge.call('messages.forward', {
        messageId,
        conversationIds,
        ...(edit ? { edit } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/pollVote') {
      const { messageId, optionIndexes } = await readJson(req);
      const result = await bridge.call('polls.vote', {
        messageId,
        optionIndexes,
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/pollEnd') {
      const { messageId } = await readJson(req);
      sendJson(res, 200, await bridge.call('polls.end', { messageId }));
      return;
    }
    if (req.method === 'POST' && route === 'api/pollSend') {
      const { conversationIds, question, options, allowMultiple } =
        await readJson(req);
      const result = await bridge.call('polls.send', {
        conversationIds,
        question,
        options,
        allowMultiple: allowMultiple === true,
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/edit') {
      const { messageId, body, mentions, formatting } = await readJson(req);
      const result = await bridge.call('messages.edit', {
        messageId,
        body,
        ...(mentions?.length ? { mentions } : {}),
        ...(formatting?.length ? { formatting } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/delete') {
      const { messageId, forEveryone } = await readJson(req);
      const result = await bridge.call('messages.delete', {
        messageId,
        forEveryone: forEveryone === true,
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/markRead') {
      const { conversationId, upToMessageId } = await readJson(req);
      const result = await bridge.call('messages.markRead', {
        conversationId,
        upToMessageId,
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/retry') {
      bridge.retryApproval();
      sendJson(res, 200, {});
      return;
    }
    if (req.method === 'GET' && route === 'api/events') {
      if (streams.size >= MAX_EVENT_STREAMS) {
        sendJson(res, 429, { error: { code: 'TOO_MANY_STREAMS' } });
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`event: hello\ndata: {}\n\n`);
      streams.add(res);
      updateNotificationHandoff();
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        streams.delete(res);
        updateNotificationHandoff();
      });
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
  }

  const server = createServer(async (req, res) => {
    const refused = checkRequest(req, { origins, token });
    if (refused) {
      const [status, reason] = refused;
      log(`refused ${req.method} (${reason})`);
      send(res, status, 'text/plain; charset=utf-8', reason);
      return;
    }
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.split('/').slice(2).join('/');

    if (route.startsWith('api/')) {
      try {
        await handleApi(req, res, route, url);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status =
          error.code === 'OFFLINE'
            ? 503
            : error.code === 'NOT_FOUND'
              ? 404
              : 400;
        sendJson(res, status, {
          error: {
            code: error.code ?? 'ERROR',
            reason: error.reason,
            message: error.message,
          },
        });
      }
      return;
    }

    // The page must be loaded as /<token>/ so relative URLs keep the token.
    if (route === '' && !url.pathname.endsWith('/')) {
      res.writeHead(308, { ...SECURITY_HEADERS, Location: `/${token}/` });
      res.end();
      return;
    }
    if (req.method === 'GET' && route === 'fonts/emoji-large.woff2') {
      const bytes = await getLargeEmojiFont();
      if (!bytes) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'font/woff2',
        'Cache-Control': 'private, max-age=604800',
      });
      res.end(bytes);
      return;
    }
    const font = FONT_FILES[route];
    if (req.method === 'GET' && font && fontDir) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'font/woff2',
        'Cache-Control': 'private, max-age=604800',
      });
      res.end(readFileSync(join(fontDir, font)));
      return;
    }
    const entry = STATIC_FILES[route];
    if (req.method !== 'GET' || !entry) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const [file, type] = entry;
    const path = join(publicDir, file);
    if (!existsSync(path)) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    send(res, 200, type, readFileSync(path));
  });

  return {
    server,
    broadcast,
    uploadStream,
    // A new connection may come with a different Signal or settings.
    forgetCachedState() {
      emojiCatalog = null;
    },
    get streamCount() {
      return streams.size;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindAddress, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      for (const res of streams) {
        res.end();
      }
      streams.clear();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}
