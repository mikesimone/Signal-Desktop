// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Immich picker (decision F48), as Backchannel Android bc9: attach photos
// and videos from your own Immich server. The helper talks to Immich so the
// API key stays in its config folder (immich.json, mode 0600) and never
// reaches the browser, and so the browser needs no CORS from Immich.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_SIZE = 60;
// Types a browser and Signal show as they are; others (HEIC, RAW) go as
// Immich's JPEG preview, as on Android.
const SENDABLE_IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const TIMEOUT_MS = 30_000;

export function extensionFor(contentType) {
  const sub = String(contentType ?? '').split('/')[1] ?? 'bin';
  return (
    { jpeg: 'jpg', quicktime: 'mov' }[sub] ?? sub.replace(/[^a-z0-9]/g, '')
  );
}

// "2026-11-11T13:37:38.066-08:00": the instant written in a time zone, which
// is what makes Immich show the local time (Signal sends no EXIF zone, so it
// would otherwise treat the send time as UTC). BACKCHANNEL_TZ, default Pacific.
export function localIso(ms, timeZone = process.env.BACKCHANNEL_TZ || 'America/Los_Angeles') {
  const at = new Date(ms);
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(at)
    .find(p => p.type === 'timeZoneName')?.value;
  const offset = /GMT([+-]\d\d:\d\d)/.exec(zone ?? '')?.[1] ?? '+00:00';
  const sign = offset[0] === '-' ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  const shifted = new Date(ms + sign * (h * 60 + m) * 60_000);
  return `${shifted.toISOString().slice(0, 23)}${offset}`;
}

// What the key made at sign-in may do: browse, attach, and auto-save (F56).
const KEY_PERMISSIONS = [
  'asset.read',
  'asset.view',
  'asset.download',
  'asset.upload',
  'asset.update',
  'album.read',
];

// The address the user typed, without a trailing / or /api; null if it
// isn't http(s).
function normalizeUrl(url) {
  let base;
  try {
    base = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(base.protocol)) {
    return null;
  }
  return base.origin + base.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
}

export class Immich {
  #file;
  #config = null;
  #fetch;

  constructor(dir, fetchImpl = globalThis.fetch) {
    this.#file = dir ? join(dir, 'immich.json') : null;
    this.#fetch = fetchImpl;
    if (this.#file && existsSync(this.#file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8'));
        if (parsed?.url && parsed?.apiKey) {
          this.#config = { url: parsed.url, apiKey: parsed.apiKey };
        }
      } catch {
        this.#config = null;
      }
    }
  }

  // What the page may see: never the key.
  status() {
    return { connected: this.#config != null, url: this.#config?.url ?? null };
  }

  // Sign in with your Immich email and password (decision F58), as the
  // server's own login: the helper makes itself an API key with just what
  // Backchannel uses, signs the session out, and never keeps the password.
  async signIn(url, email, password) {
    const base = normalizeUrl(url);
    if (!base || !email || !password) {
      return { ok: false, code: 'INVALID_ARGUMENT' };
    }
    const post = async (path, body, token) => {
      let res;
      try {
        res = await this.#fetch(base + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw Object.assign(new Error('unreachable'), { code: 'UNREACHABLE' });
      }
      return res;
    };
    try {
      const login = await post('/api/auth/login', { email, password });
      if (login.status === 401 || login.status === 400) {
        return { ok: false, code: 'BAD_LOGIN' };
      }
      if (!login.ok) {
        return { ok: false, code: 'IMMICH_ERROR' };
      }
      const { accessToken } = await login.json();
      const made = await post(
        '/api/api-keys',
        { name: 'Backchannel', permissions: KEY_PERMISSIONS },
        accessToken
      );
      await post('/api/auth/logout', {}, accessToken).catch(() => {});
      if (!made.ok) {
        return { ok: false, code: 'IMMICH_ERROR' };
      }
      const { secret } = await made.json();
      return this.configure(base, secret);
    } catch (error) {
      return { ok: false, code: error.code ?? 'UNREACHABLE' };
    }
  }

  // Checks the server and key before saving them. Empty url disconnects.
  async configure(url, apiKey) {
    if (!this.#file) {
      return { ok: false, code: 'UNAVAILABLE' };
    }
    if (!url) {
      this.#config = null;
      this.#save();
      return { ok: true };
    }
    const base = normalizeUrl(url);
    if (!base || !apiKey) {
      return { ok: false, code: 'INVALID_ARGUMENT' };
    }
    const config = { url: base, apiKey: String(apiKey).trim() };
    try {
      await this.#json(config, 'GET', '/api/albums');
    } catch (error) {
      return { ok: false, code: error.code ?? 'UNREACHABLE' };
    }
    this.#config = config;
    this.#save();
    return { ok: true };
  }

  async recent(page = 1, albumId = null) {
    const body = { page, size: PAGE_SIZE, order: 'desc' };
    if (albumId) {
      body.albumIds = [albumId];
    }
    return this.#assets(
      await this.#json(this.#config, 'POST', '/api/search/metadata', body)
    );
  }

  async search(query, page = 1) {
    return this.#assets(
      await this.#json(this.#config, 'POST', '/api/search/smart', {
        query,
        page,
        size: PAGE_SIZE,
      })
    );
  }

  async albums() {
    const list = await this.#json(this.#config, 'GET', '/api/albums');
    return (Array.isArray(list) ? list : []).map(a => ({
      id: String(a.id),
      name: String(a.albumName ?? ''),
      count: Number(a.assetCount ?? 0),
      thumbnailId: a.albumThumbnailAssetId
        ? String(a.albumThumbnailAssetId)
        : null,
    }));
  }

  thumbnail(id) {
    return this.#binary(
      `/api/assets/${encodeURIComponent(id)}/thumbnail?size=thumbnail`
    );
  }

  // The file to send: the original, or a JPEG preview for HEIC and RAW.
  async original(id, mimeType) {
    const asImage = String(mimeType ?? '').startsWith('image/');
    const path =
      asImage && !SENDABLE_IMAGES.has(mimeType)
        ? `/api/assets/${encodeURIComponent(id)}/thumbnail?size=preview`
        : `/api/assets/${encodeURIComponent(id)}/original`;
    return this.#binary(path);
  }

  // Auto-save (decision F56): adds a received photo or video to Immich.
  // deviceAssetId keeps Immich from taking the same file twice.
  async upload(bytes, { deviceAssetId, fileName, contentType, createdAt }) {
    if (!this.#config) {
      throw Object.assign(new Error('not connected'), {
        code: 'NOT_CONNECTED',
      });
    }
    const when = new Date(createdAt).toISOString();
    const form = new FormData();
    form.set('deviceAssetId', deviceAssetId);
    form.set('deviceId', 'backchannel');
    form.set('fileCreatedAt', when);
    form.set('fileModifiedAt', when);
    form.set(
      'assetData',
      new Blob([bytes], { type: contentType || 'application/octet-stream' }),
      fileName || `${deviceAssetId}.${extensionFor(contentType)}`
    );
    let res;
    try {
      res = await this.#fetch(`${this.#config.url}/api/assets`, {
        method: 'POST',
        headers: { 'x-api-key': this.#config.apiKey },
        body: form,
        signal: AbortSignal.timeout(5 * TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('unreachable'), { code: 'UNREACHABLE' });
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('bad key'), { code: 'BAD_KEY' });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: 'IMMICH_ERROR',
      });
    }
    const made = await res.json().catch(() => ({}));
    // Best effort: show the time where Mike took it, not in UTC. A key that
    // may not edit assets just leaves the UTC time.
    if (made?.id && made.status !== 'duplicate') {
      await this.#fetch(`${this.#config.url}/api/assets/${made.id}`, {
        method: 'PUT',
        headers: {
          'x-api-key': this.#config.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dateTimeOriginal: localIso(createdAt) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {});
    }
    return made;
  }

  #assets(result) {
    const assets = result?.assets ?? {};
    return {
      items: (assets.items ?? []).map(a => ({
        id: String(a.id),
        type: a.type === 'VIDEO' ? 'video' : 'image',
        fileName: String(a.originalFileName ?? ''),
        mimeType: String(a.originalMimeType ?? ''),
      })),
      nextPage: assets.nextPage ? Number(assets.nextPage) : null,
    };
  }

  async #request(config, method, path, body) {
    if (!config) {
      throw Object.assign(new Error('not connected'), {
        code: 'NOT_CONNECTED',
      });
    }
    let res;
    try {
      res = await this.#fetch(config.url + path, {
        method,
        headers: {
          'x-api-key': config.apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('unreachable'), { code: 'UNREACHABLE' });
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('bad key'), { code: 'BAD_KEY' });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: 'IMMICH_ERROR',
      });
    }
    return res;
  }

  async #json(config, method, path, body) {
    const res = await this.#request(config, method, path, body);
    return res.json();
  }

  async #binary(path) {
    const res = await this.#request(this.#config, 'GET', path);
    return {
      contentType:
        res.headers.get('content-type') ?? 'application/octet-stream',
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#config ?? {}), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
}
