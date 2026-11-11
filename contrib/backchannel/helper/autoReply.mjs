// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Auto-reply (decision F56), as Backchannel Android v14: while it's on, a
// new message from someone in a 1:1 chat gets your reply text, at most once
// per chat in each quiet period. The helper sends it, so it works with no
// page open. Kept in the config folder (auto-reply.json, mode 0600).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_TEXT = 1000;
// Older messages (Signal catching up after being offline) get no reply.
const FRESH_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Backchannel's auto-reply marker (decision F57), agreed with Backchannel
// Android: an invisible ending other Signal apps don't show. It lets the web
// and the phone see each other's auto-replies, so only one goes out.
export const AUTO_REPLY_MARKER = '\u2063\u2062';

export function cleanAutoReply(value) {
  const hours = Number(value?.cooldownHours);
  return {
    enabled: value?.enabled === true,
    text: String(value?.text ?? '').slice(0, MAX_TEXT),
    cooldownHours:
      Number.isFinite(hours) && hours >= 0 && hours <= 24 * 7
        ? Math.round(hours)
        : 12,
  };
}

export class AutoReply {
  #file;
  #settings = cleanAutoReply(null);
  // conversationId -> when we last auto-replied there.
  #lastSent = {};
  #send;
  #now;
  #log;

  constructor(file, { send, now = Date.now, log = () => {} } = {}) {
    this.#file = file;
    this.#send = send;
    this.#now = now;
    this.#log = log;
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        this.#settings = cleanAutoReply(parsed);
        if (parsed?.lastSent && typeof parsed.lastSent === 'object') {
          this.#lastSent = parsed.lastSent;
        }
      } catch {
        this.#settings = cleanAutoReply(null);
      }
    }
  }

  get() {
    return { ...this.#settings };
  }

  set(value) {
    if (!this.#file) {
      return null;
    }
    const before = this.#settings.enabled;
    this.#settings = cleanAutoReply(value);
    // Turning it on again starts a fresh period for everyone.
    if (this.#settings.enabled && !before) {
      this.#lastSent = {};
    }
    this.#save();
    return this.get();
  }

  // An auto-reply this account sent from any device (sync transcripts
  // included) starts that chat's quiet period here too.
  observe(m) {
    if (
      m?.direction !== 'outgoing' ||
      !m.body?.endsWith(AUTO_REPLY_MARKER) ||
      !m.conversationId
    ) {
      return;
    }
    const at = Math.min(m.sentAt ?? this.#now(), this.#now());
    if (at > (this.#lastSent[m.conversationId] ?? 0)) {
      this.#lastSent[m.conversationId] = at;
      if (this.#file) {
        this.#save();
      }
    }
  }

  // m: a message.added MessageDTO; conversation: its ConversationDTO.
  async handle(m, conversation) {
    this.observe(m);
    const { enabled, text, cooldownHours } = this.#settings;
    const now = this.#now();
    if (
      !enabled ||
      !text.trim() ||
      m?.direction !== 'incoming' ||
      // Never answer someone else's auto-reply.
      m.body?.endsWith(AUTO_REPLY_MARKER) ||
      !conversation ||
      conversation.type !== 'direct' ||
      conversation.noteToSelf ||
      conversation.blocked ||
      conversation.messageRequestPending ||
      !(now - (m.sentAt ?? 0) < FRESH_MS)
    ) {
      return false;
    }
    const last = this.#lastSent[conversation.id] ?? 0;
    if (now - last < Math.max(cooldownHours * HOUR_MS, 60_000)) {
      return false;
    }
    this.#lastSent[conversation.id] = now;
    this.#save();
    try {
      await this.#send(conversation.id, text.trim() + AUTO_REPLY_MARKER);
      return true;
    } catch (error) {
      this.#log(`auto-reply failed: ${error.code ?? error.message}`);
      return false;
    }
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ...this.#settings, lastSent: this.#lastSent }),
      { mode: 0o600 }
    );
    renameSync(tmp, this.#file);
  }
}
