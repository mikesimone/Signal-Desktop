// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The local web side of signal-rambox: a small HTTP server on 127.0.0.1 that
// serves the chat page Rambox loads, a JSON API over the bridge, and a
// Server-Sent Events stream of live updates.
//
// Anything on this computer can open a loopback port, including web pages in
// a browser, so every request must:
//   - carry the secret token as its first path segment,
//   - name this server in Host (stops DNS rebinding),
//   - if it has an Origin, come from this server (stops other pages),
//   - for POST, send application/json (forces a CORS preflight, which this
//     server never approves).

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const MAX_BODY_BYTES = 128 * 1024;
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
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'self'; " +
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
    if (type !== 'application/json') {
      return [415, 'expected application/json'];
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
  log,
}) {
  const streams = new Set();
  // conversationId -> { avatarVersion, contentType, bytes }
  const avatars = new Map();
  const avatarLoads = new Map();
  let avatarCalls = 0;
  const avatarQueue = [];
  let preferredReactions = null;

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
    if (url.searchParams.has('preview')) {
      return { messageId, preview: Number(url.searchParams.get('preview')) };
    }
    return { messageId, index: Number(url.searchParams.get('index') ?? 0) };
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
      const thumb = await bridge.call('attachments.getThumbnail', target);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': thumb.contentType,
        'Cache-Control': 'private, max-age=3600',
      });
      res.end(Buffer.from(thumb.data, 'base64'));
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
      preferredReactions ??= await bridge.call('reactions.getPreferred', {});
      sendJson(res, 200, preferredReactions);
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
    if (req.method === 'GET' && route === 'api/messages') {
      const conversationId = url.searchParams.get('conversationId');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = await bridge.call('messages.list', {
        conversationId,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/send') {
      const { conversationId, body, quoteMessageId } = await readJson(req);
      const result = await bridge.call('messages.sendText', {
        conversationId,
        body,
        ...(quoteMessageId ? { quoteMessageId } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && route === 'api/edit') {
      const { messageId, body } = await readJson(req);
      const result = await bridge.call('messages.edit', { messageId, body });
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
    send(res, 200, type, readFileSync(join(publicDir, file)));
  });

  return {
    server,
    broadcast,
    // A new connection may come with a different Signal or settings.
    forgetCachedState() {
      preferredReactions = null;
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
