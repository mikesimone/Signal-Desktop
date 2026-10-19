// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Keeps the photos from the phone's contacts fresh (decision F37). Linked
// Signal imports contacts only when it's linked or asked, so the helper asks
// once a day, and shortly after someone new starts a 1:1 chat.

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
// Several new chats at once make one request.
const NEW_CHAT_DELAY_MS = 30_000;
const NEW_CHAT_MIN_GAP_MS = 10 * 60 * 1000;

export class ContactPhotoRefresh {
  #file;
  #lastAt = 0;
  #timer = null;
  #pending = null;
  #running = false;
  #pageOpenedAt = 0;
  #sync;
  #ready;
  #log;

  constructor(configDir, { sync, ready, log }) {
    this.#file = join(configDir, 'contact-sync.json');
    this.#sync = sync;
    this.#ready = ready;
    this.#log = log;
    try {
      this.#lastAt = JSON.parse(readFileSync(this.#file, 'utf8')).lastAt ?? 0;
    } catch {
      this.#lastAt = 0;
    }
  }

  get lastAt() {
    return this.#lastAt;
  }

  start() {
    this.#timer = setInterval(() => this.daily(), CHECK_EVERY_MS);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#pending);
  }

  // Also when Signal comes back, so a long outage catches up.
  async daily() {
    if (Date.now() - this.#lastAt >= DAY_MS) {
      await this.run('daily');
    }
  }

  newChat() {
    if (
      this.#pending ||
      Date.now() - this.#lastAt < NEW_CHAT_MIN_GAP_MS ||
      Date.now() - this.#pageOpenedAt < NEW_CHAT_DELAY_MS
    ) {
      return;
    }
    this.#pending = setTimeout(() => {
      this.#pending = null;
      // The page may have opened the chat, asking the phone already.
      if (Date.now() - this.#lastAt >= NEW_CHAT_MIN_GAP_MS) {
        void this.run('new chat');
      }
    }, NEW_CHAT_DELAY_MS);
    this.#pending.unref?.();
  }

  // A chat started from the page: Signal asked the phone before opening it,
  // so the new chat it reports needs nothing more.
  openedByPage() {
    this.#pageOpenedAt = Date.now();
    clearTimeout(this.#pending);
    this.#pending = null;
  }

  // Imports made from the page count too.
  record(at = Date.now()) {
    this.#lastAt = at;
    try {
      writeFileSync(this.#file, JSON.stringify({ lastAt: at }), {
        mode: 0o600,
      });
    } catch (error) {
      this.#log(`contact sync: couldn't save the time (${error.code})`);
    }
  }

  async run(why) {
    if (this.#running || !this.#ready()) {
      return;
    }
    this.#running = true;
    try {
      const { syncedAt } = await this.#sync();
      this.record(syncedAt);
      this.#log(`contact sync (${why}): done`);
    } catch (error) {
      this.#log(`contact sync (${why}) failed: ${error.code ?? error.message}`);
    } finally {
      this.#running = false;
    }
  }
}
