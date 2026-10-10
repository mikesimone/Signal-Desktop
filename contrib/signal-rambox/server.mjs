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
    "img-src 'self'; connect-src 'self'; base-uri 'none'; " +
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
  store,
  bridge,
  log,
}) {
  const streams = new Set();

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      res.write(payload);
    }
  }

  function updateNotificationHandoff() {
    bridge.setNotificationsWanted(streams.size > 0).catch(() => {});
  }

  async function handleApi(req, res, route, url) {
    if (req.method === 'GET' && route === 'api/state') {
      sendJson(res, 200, store.snapshot());
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
      const { conversationId, body } = await readJson(req);
      const result = await bridge.call('messages.sendText', {
        conversationId,
        body,
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
        sendJson(res, error.code === 'OFFLINE' ? 503 : 400, {
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
