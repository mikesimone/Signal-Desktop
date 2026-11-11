// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// How the page shows chats (decision F55), as Backchannel Android: blur
// photos and videos until clicked, everywhere or in chosen chats. Kept in
// the helper's config folder (view-prefs.json, mode 0600) so every open page
// uses the same choices. Nothing here reaches Signal.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_CHATS = 2000;

export function cleanViewPrefs(value) {
  const chats = Array.isArray(value?.blurChats) ? value.blurChats : [];
  return {
    blurAll: value?.blurAll === true,
    blurChats: [
      ...new Set(
        chats.filter(id => typeof id === 'string' && id && id.length <= 128)
      ),
    ].slice(0, MAX_CHATS),
  };
}

export class ViewPrefs {
  #file;
  #prefs = cleanViewPrefs(null);

  constructor(file) {
    this.#file = file;
    if (file && existsSync(file)) {
      try {
        this.#prefs = cleanViewPrefs(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        this.#prefs = cleanViewPrefs(null);
      }
    }
  }

  get() {
    return { ...this.#prefs, blurChats: [...this.#prefs.blurChats] };
  }

  set(value) {
    if (!this.#file) {
      return null;
    }
    this.#prefs = cleanViewPrefs(value);
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#prefs), { mode: 0o600 });
    renameSync(tmp, this.#file);
    return this.get();
  }
}
