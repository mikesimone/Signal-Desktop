// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The helper's copy of Signal's conversation list, kept current from bridge
// events so the page can load it in one request. Messages are not cached
// here; the page asks Signal for them.

export class Store {
  #conversations = new Map();
  state = 'offline';

  clear() {
    this.#conversations.clear();
  }

  async load(bridge) {
    const next = new Map();
    let cursor;
    do {
      const page = await bridge.call('conversations.list', {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of page.conversations) {
        next.set(c.id, c);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    this.#conversations = next;
  }

  apply({ event, data }) {
    if (event === 'conversation.updated') {
      this.#conversations.set(data.id, data);
    } else if (event === 'conversation.removed') {
      this.#conversations.delete(data.conversationId);
    }
  }

  snapshot() {
    return {
      state: this.state,
      conversations: [...this.#conversations.values()],
    };
  }
}
