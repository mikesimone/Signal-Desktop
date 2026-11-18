// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Starred messages (decision F43), as Backchannel Android and Signal's own
// Labs feature have them. Signal Desktop has no star, and stars never sync
// between devices, so the helper keeps them in its config folder.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_STARS = 5000;

export class Stars {
  #file;
  #items = [];

  constructor(file) {
    this.#file = file;
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) {
          this.#items = parsed.filter(isItem);
        }
      } catch {
        this.#items = [];
      }
    }
  }

  // Newest star first; one chat's, or all.
  list(conversationId) {
    return this.#items
      .filter(i => !conversationId || i.conversationId === conversationId)
      .toSorted((a, b) => b.starredAt - a.starredAt);
  }

  ids() {
    return this.#items.map(i => i.messageId);
  }

  has(messageId) {
    return this.#items.some(i => i.messageId === messageId);
  }

  set({ messageId, conversationId, starred }, now = Date.now()) {
    const rest = this.#items.filter(i => i.messageId !== messageId);
    const item = { messageId, conversationId, starredAt: now };
    if (starred && !isItem(item)) {
      return false;
    }
    this.#items = starred ? [...rest, item].slice(-MAX_STARS) : rest;
    if (this.#file) {
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.#items), { mode: 0o600 });
      renameSync(temp, this.#file);
    }
    return true;
  }
}

function isItem(i) {
  return (
    i != null &&
    typeof i === 'object' &&
    typeof i.messageId === 'string' &&
    i.messageId.length > 0 &&
    i.messageId.length <= 128 &&
    typeof i.conversationId === 'string' &&
    i.conversationId.length > 0 &&
    i.conversationId.length <= 128 &&
    typeof i.starredAt === 'number'
  );
}
