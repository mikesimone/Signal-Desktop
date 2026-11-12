// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Auto-save received photos and videos (decision F56), as Backchannel
// Android v14 saves them to the phone's gallery: here the gallery is your
// Immich (F48). In every chat or in chosen ones. The helper saves them as
// Signal finishes downloading them, with no page open. Choices and what was
// already saved are kept in the config folder (auto-save.json, mode 0600).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extensionFor } from './immich.mjs';

const MAX_CHATS = 2000;
const MAX_DONE = 20_000;
const CHUNK = 512 * 1024;

function cleanIds(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : []).filter(
        id => typeof id === 'string' && id && id.length <= 128
      )
    ),
  ].slice(0, MAX_CHATS);
}

// all: every chat; chats: picked ones; skip: chats left out of "every chat".
export function cleanAutoSave(value) {
  const skip = cleanIds(value?.skip);
  return {
    all: value?.all === true,
    chats: cleanIds(value?.chats).filter(id => !skip.includes(id)),
    skip,
  };
}

// What Immich shows for a saved file: ChatName_2026-11-11_134355.jpg, in the
// owner's time zone (BACKCHANNEL_TZ, default Pacific). A message with several
// attachments gets -2, -3 on the later ones. Signal sends no file name for
// most photos, so this replaces "attachment".
export function savedName(title, sentAt, index, a) {
  const chat =
    String(title ?? '')
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'Signal';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: process.env.BACKCHANNEL_TZ || 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(sentAt))
      .map(p => [p.type, p.value])
  );
  const stamp = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
  const own = /\.([A-Za-z0-9]{1,5})$/.exec(a?.fileName ?? '')?.[1];
  const ext = (own ?? extensionFor(a?.contentType)).toLowerCase();
  return `${chat}_${stamp}${index > 0 ? `-${index + 1}` : ''}.${ext}`;
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
    return {
      ...this.#settings,
      chats: [...this.#settings.chats],
      skip: [...this.#settings.skip],
    };
  }

  set(value) {
    if (!this.#file) {
      return null;
    }
    this.#settings = cleanAutoSave(value);
    this.#save();
    return this.get();
  }

  // A chat picked in its ⋯ menu is always saved. "Every chat" leaves out
  // archived and muted groups (Mike, 2026-11-11).
  wants(conversationId, conversation = null) {
    if (this.#settings.skip.includes(conversationId)) {
      return false;
    }
    if (this.#settings.chats.includes(conversationId)) {
      return true;
    }
    return (
      this.#settings.all &&
      !(
        conversation?.type === 'group' &&
        (conversation.archived || conversation.muted)
      )
    );
  }

  // m: a message.added or message.updated MessageDTO; conversation: its
  // ConversationDTO. Returns the work, so tests can wait. Chats with
  // disappearing messages are saved too (Mike's call: the timer is there to
  // save phone space, not for privacy). View-once media never reaches the
  // helper: the bridge hides its content.
  handle(m, conversation) {
    if (
      m?.direction !== 'incoming' ||
      m.kind === 'viewOnce' ||
      !this.wants(m.conversationId, conversation) ||
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
        .then(() => this.#saveOne(m, index, a, key, conversation))
        .finally(() => this.#pending.delete(key));
    });
    return this.#queue;
  }

  async #saveOne(m, index, a, key, conversation) {
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
        fileName: savedName(
          conversation?.title,
          m.sentAt ?? Date.now(),
          index,
          a
        ),
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
