// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Auto-save received photos and videos (decision F56), as Backchannel
// Android v14 saves them to the phone's gallery: here the gallery is your
// Immich (F48). In every chat or in chosen ones. The helper saves them as
// Signal finishes downloading them, with no page open. Choices and what was
// already saved are kept in the config folder (auto-save.json, mode 0600).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_CHATS = 2000;
const MAX_DONE = 20_000;
const CHUNK = 512 * 1024;

export function cleanAutoSave(value) {
  const chats = Array.isArray(value?.chats) ? value.chats : [];
  return {
    all: value?.all === true,
    chats: [
      ...new Set(
        chats.filter(id => typeof id === 'string' && id && id.length <= 128)
      ),
    ].slice(0, MAX_CHATS),
  };
}

function isMedia(a) {
  return /^(image|video)\//.test(a?.contentType ?? '');
}

export class AutoSave {
  #file;
  #settings = cleanAutoSave(null);
  #done = new Set();
  #queue = Promise.resolve();
  #pending = new Set();
  #bridge;
  #immich;
  #log;

  constructor(file, { bridge, immich, log = () => {} } = {}) {
    this.#file = file;
    this.#bridge = bridge;
    this.#immich = immich;
    this.#log = log;
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        this.#settings = cleanAutoSave(parsed);
        if (Array.isArray(parsed?.done)) {
          this.#done = new Set(parsed.done.slice(-MAX_DONE));
        }
      } catch {
        this.#settings = cleanAutoSave(null);
      }
    }
  }

  get() {
    return { ...this.#settings, chats: [...this.#settings.chats] };
  }

  set(value) {
    if (!this.#file) {
      return null;
    }
    this.#settings = cleanAutoSave(value);
    this.#save();
    return this.get();
  }

  wants(conversationId) {
    return this.#settings.all || this.#settings.chats.includes(conversationId);
  }

  // m: a message.added or message.updated MessageDTO. Returns the work, so
  // tests can wait for it.
  handle(m) {
    if (
      m?.direction !== 'incoming' ||
      !this.wants(m.conversationId) ||
      !this.#immich?.status().connected
    ) {
      return this.#queue;
    }
    (m.attachments ?? []).forEach((a, index) => {
      const key = `${m.id}:${index}`;
      if (
        !isMedia(a) ||
        a.state !== 'ready' ||
        this.#done.has(key) ||
        this.#pending.has(key)
      ) {
        return;
      }
      this.#pending.add(key);
      this.#queue = this.#queue
        .then(() => this.#saveOne(m, index, a, key))
        .finally(() => this.#pending.delete(key));
    });
    return this.#queue;
  }

  async #saveOne(m, index, a, key) {
    try {
      const chunks = [];
      let offset = 0;
      let size = Infinity;
      while (offset < size) {
        // oxlint-disable-next-line no-await-in-loop
        const chunk = await this.#bridge.call('attachments.read', {
          messageId: m.id,
          index,
          offset,
          length: CHUNK,
        });
        size = chunk.size;
        const bytes = Buffer.from(chunk.data, 'base64');
        if (bytes.length === 0) {
          break;
        }
        chunks.push(bytes);
        offset += bytes.length;
      }
      await this.#immich.upload(Buffer.concat(chunks), {
        deviceAssetId: `signal-${key}`,
        fileName: a.fileName ?? null,
        contentType: a.contentType,
        createdAt: m.sentAt ?? Date.now(),
      });
      this.#done.add(key);
      if (this.#done.size > MAX_DONE) {
        this.#done = new Set([...this.#done].slice(-MAX_DONE));
      }
      this.#save();
    } catch (error) {
      this.#log(`auto-save failed: ${error.code ?? error.message}`);
    }
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ...this.#settings, done: [...this.#done] }),
      { mode: 0o600 }
    );
    renameSync(tmp, this.#file);
  }
}
