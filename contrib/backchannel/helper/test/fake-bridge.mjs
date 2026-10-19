// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for Signal's bridge, enough for Backchannel's helper tests: real
// framing and signatures, canned conversations and messages.

import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { createServer } from 'node:net';

const CLIENT_LABEL = 'signal-external-client/v1/client-auth';
const SERVER_LABEL = 'signal-external-client/v1/server-auth';

function transcript(parts) {
  const chunks = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      chunks.push(Buffer.from([0]));
    }
    chunks.push(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  });
  return Buffer.concat(chunks);
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function makeConversation(overrides = {}) {
  return {
    id: randomUUID(),
    type: 'direct',
    title: 'Alice',
    unreadCount: 0,
    unreadMentionsCount: 0,
    markedUnread: false,
    lastActivityAt: Date.now(),
    muted: false,
    archived: false,
    pinned: false,
    blocked: false,
    noteToSelf: false,
    messageRequestPending: false,
    memberCount: null,
    avatarColor: 'A120',
    avatarVersion: null,
    lastMessage: null,
    pinnedIndex: null,
    mutedUntil: null,
    disappearingSeconds: 0,
    canChangeTimer: true,
    ...overrides,
  };
}

export function makeMessage(conversationId, overrides = {}) {
  return {
    id: randomUUID(),
    conversationId,
    direction: 'incoming',
    kind: 'text',
    authorConversationId: conversationId,
    author: {
      title: 'Alice',
      avatarColor: 'A120',
      avatarVersion: null,
      nameColor: null,
      label: null,
    },
    sentAt: Date.now(),
    receivedAt: Date.now(),
    body: 'hello',
    bodyTruncated: false,
    mentions: [],
    attachments: [],
    quote: null,
    edited: false,
    expiresAt: null,
    read: false,
    sendStatus: null,
    reactions: [],
    sticker: null,
    formatting: [],
    previews: [],
    canEdit: false,
    canDeleteForEveryone: false,
    ...overrides,
  };
}

export class FakeBridge {
  #server;
  #sessions = new Set();
  #keys = generateKeyPairSync('ed25519');
  // 'approve' | 'deny'
  approval = 'approve';
  // false: like a new install before linking (authorization.request answers
  // NOT_READY without a dialog).
  linked = true;
  grants = new Map();
  conversations = [];
  messages = new Map();
  // conversationId -> [{ conversationId, author }]
  members = new Map();
  stickers = { packs: [], recents: [] };
  // conversationId -> ConversationDetailsDTO
  details = new Map();
  #quoteOf(messageId) {
    for (const list of this.messages.values()) {
      const quoted = list.find(m => m.id === messageId);
      if (quoted) {
        return {
          authorConversationId: quoted.authorConversationId,
          author: quoted.author,
          sentAt: quoted.sentAt,
          text: quoted.body,
          attachment: quoted.attachments[0]
            ? {
                contentType: quoted.attachments[0].contentType,
                fileName: quoted.attachments[0].fileName ?? null,
                isVoiceMessage: quoted.attachments[0].isVoiceMessage ?? false,
                isGif: quoted.attachments[0].contentType === 'image/gif',
                hasThumbnail: quoted.attachments[0].hasThumbnail ?? false,
              }
            : null,
        };
      }
    }
    return null;
  }

  // linkPreviews.fetch: url -> { title, description, domain, date, image }
  linkPreviews = new Map();
  // messages.locateQuote: messageId -> { conversationId, messageId }
  quoteLocations = new Map();
  // messages.list page size; unset returns everything at once.
  pageSize = 0;
  settings = {
    emojiSkinTone: '',
    linkPreviews: true,
    sentMediaQuality: 'standard',
    keepMutedChatsArchived: false,
    readReceipts: true,
    typingIndicators: true,
    sealedSenderIndicators: false,
    disappearingMessagesSeconds: 0,
    phoneNumberSharing: 'nobody',
    phoneNumberDiscoverable: true,
    notificationContent: 'message',
    notificationSound: false,
    reactionNotifications: true,
    autoDownload: { photos: true, videos: true, audio: true, documents: true },
    storiesEnabled: true,
    blocked: [],
  };
  profile = {
    conversationId: 'me',
    firstName: 'Mike',
    familyName: '',
    aboutText: '',
    aboutEmoji: '',
    username: null,
    avatarColor: 'A120',
    avatarVersion: null,
  };
  // The last profile.setAvatar data (base64, or null to remove).
  profilePhoto = undefined;
  calls = [];
  notificationsHandled = false;
  // conversationId -> reason, for messages.sendText refusals
  sendRefusals = new Map();
  // What hello advertises.
  offered = [
    'conversations.read',
    'messages.read',
    'messages.send',
    'messages.markRead',
    'messages.react',
    'attachments.read',
    'notifications.manage',
    'settings.manage',
    'typing.read',
    'typing.send',
    'conversations.manage',
    'contacts.read',
    'conversations.create',
    'groups.manage',
  ];
  // contacts.list and conversations.find.
  contacts = [];
  findable = new Map();
  // `${messageId}:${index}` -> { contentType, bytes }
  attachments = new Map();
  // conversationId -> { avatarVersion, contentType, data }
  avatars = new Map();
  // uploadId -> { contentType, fileName, size, bytes: Buffer[] }
  uploads = new Map();
  recentEmoji = ['🦃', '🤘'];
  emojiCatalog = [
    {
      id: 'SMILIES_AND_PEOPLE',
      emoji: [
        ['😀', 'grinning'],
        ['😂', 'joy'],
        ['🤘', 'the_horns'],
      ],
    },
    { id: 'ANIMALS_AND_NATURE', emoji: [['🦃', 'turkey']] },
  ];
  reactionEmoji = ['🔥', '👍', '👎', '😂', '😮', '😢'];

  get publicKey() {
    return this.#keys.publicKey.export({ format: 'jwk' }).x;
  }

  listen(path) {
    this.#server = createServer(socket => this.#onConnection(socket));
    return new Promise(resolve => this.#server.listen(path, resolve));
  }

  close() {
    for (const s of this.#sessions) {
      s.socket.destroy();
    }
    return new Promise(resolve => this.#server.close(() => resolve()));
  }

  // Sends an event to every subscribed session.
  emit(event, data) {
    for (const s of this.#sessions) {
      if (s.subscribed) {
        s.seq += 1;
        s.socket.write(frame({ event, seq: s.seq, data }));
      }
    }
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  #onConnection(socket) {
    const session = {
      socket,
      seq: 0,
      subscribed: false,
      authorized: false,
      sessionId: randomUUID(),
      challenge: randomBytes(32),
    };
    this.#sessions.add(session);
    socket.on('close', () => {
      this.#sessions.delete(session);
      if (session.handles) {
        this.notificationsHandled = false;
      }
    });
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const len = buffered.readUInt32BE(1);
        if (buffered.length < 5 + len) {
          break;
        }
        const msg = JSON.parse(buffered.subarray(5, 5 + len).toString('utf8'));
        buffered = buffered.subarray(5 + len);
        this.#onRequest(session, msg);
      }
    });
  }

  #reply(session, id, result) {
    session.socket.write(frame({ id, result }));
  }

  #error(session, id, code, reason) {
    session.socket.write(
      frame({
        id,
        error: { code, message: code, ...(reason ? { reason } : {}) },
      })
    );
  }

  #onRequest(session, { id, method, params }) {
    this.calls.push({ method, params });
    switch (method) {
      case 'session.hello': {
        const clientNonce = Buffer.from(params.clientNonce, 'base64url');
        const signature = sign(
          null,
          transcript([
            SERVER_LABEL,
            session.sessionId,
            session.challenge,
            clientNonce,
          ]),
          this.#keys.privateKey
        );
        this.#reply(session, id, {
          protocolVersion: 1,
          sessionId: session.sessionId,
          signalVersion: 'fake',
          capabilities: this.offered,
          challenge: session.challenge.toString('base64url'),
          server: {
            publicKey: this.publicKey,
            signature: signature.toString('base64url'),
          },
        });
        return;
      }
      case 'authorization.request': {
        const clientKey = createPublicKey({
          key: { kty: 'OKP', crv: 'Ed25519', x: params.publicKey },
          format: 'jwk',
        });
        const ok = verify(
          null,
          transcript([CLIENT_LABEL, session.sessionId, session.challenge]),
          clientKey,
          Buffer.from(params.signature, 'base64url')
        );
        if (!ok) {
          this.#error(session, id, 'NOT_AUTHORIZED');
          session.socket.end();
          return;
        }
        if (!this.grants.has(params.publicKey) && !this.linked) {
          // Signal asks for approval only once it's linked to a phone.
          this.#error(session, id, 'NOT_READY');
          return;
        }
        if (!this.grants.has(params.publicKey) && this.approval === 'deny') {
          this.#error(session, id, 'PERMISSION_DENIED');
          session.socket.end();
          return;
        }
        this.grants.set(params.publicKey, params.capabilities);
        session.authorized = true;
        this.#reply(session, id, { capabilities: params.capabilities });
        return;
      }
      default:
        break;
    }
    if (!session.authorized) {
      this.#error(session, id, 'NOT_AUTHORIZED');
      return;
    }
    switch (method) {
      case 'events.subscribe':
        session.subscribed = true;
        this.#reply(session, id, { topics: params.topics });
        return;
      case 'notifications.setHandled':
        session.handles = params.handled;
        this.notificationsHandled = params.handled;
        this.#reply(session, id, { handled: params.handled });
        return;
      case 'conversations.list':
        this.#reply(session, id, {
          conversations: this.conversations,
          nextCursor: null,
        });
        return;
      case 'settings.get':
        this.#reply(session, id, { settings: this.settings });
        return;
      case 'profile.get':
        this.#reply(session, id, { profile: this.profile });
        return;
      case 'profile.set':
        this.profile = { ...this.profile, ...params };
        this.#reply(session, id, { profile: this.profile });
        return;
      case 'profile.setAvatar':
        this.profilePhoto = params.data;
        this.#reply(session, id, { profile: this.profile });
        return;
      case 'settings.set':
        this.settings = { ...this.settings, [params.key]: params.value };
        this.#reply(session, id, { settings: this.settings });
        return;
      case 'stickers.getPacks':
        this.#reply(session, id, this.stickers);
        return;
      case 'stickers.getImage':
        this.#reply(session, id, {
          contentType: 'image/webp',
          width: 1,
          height: 1,
          data: (
            this.stickerImageBytes ??
            Buffer.from(`sticker ${params.packId} ${params.stickerId}`)
          ).toString('base64'),
        });
        return;
      case 'messages.sendSticker': {
        const reason = this.sendRefusals.get(params.conversationId);
        if (reason) {
          this.#error(session, id, 'PRECONDITION_FAILED', reason);
          return;
        }
        this.#reply(session, id, {});
        return;
      }
      case 'conversations.getMembers':
        this.#reply(session, id, {
          members: this.members.get(params.conversationId) ?? [],
        });
        return;
      case 'messages.list': {
        const all = this.messages.get(params.conversationId) ?? [];
        if (!this.pageSize) {
          this.#reply(session, id, { messages: all, nextCursor: null });
          return;
        }
        // Newest first, a page at a time; the cursor is the oldest so far.
        const sorted = [...all].sort((a, b) => a.sentAt - b.sentAt);
        if (params.newer) {
          const from = sorted.findIndex(m => m.id === params.cursor) + 1;
          const to = Math.min(sorted.length, from + this.pageSize);
          this.#reply(session, id, {
            messages: sorted.slice(from, to),
            nextCursor: to < sorted.length ? sorted[to - 1].id : null,
          });
          return;
        }
        const end = params.cursor
          ? sorted.findIndex(m => m.id === params.cursor)
          : sorted.length;
        const start = Math.max(0, end - this.pageSize);
        this.#reply(session, id, {
          messages: sorted.slice(start, end),
          nextCursor: start > 0 ? sorted[start].id : null,
        });
        return;
      }
      case 'messages.search': {
        // Substring match, newest first, like Signal's full-text search.
        const needle = params.query.toLowerCase();
        const results = [];
        for (const [conversationId, list] of this.messages) {
          if (
            params.conversationId &&
            conversationId !== params.conversationId
          ) {
            continue;
          }
          for (const message of list) {
            if (params.onlyUnread && !message.unread) {
              continue;
            }
            const at = message.body?.toLowerCase().indexOf(needle) ?? -1;
            if (at === -1) {
              continue;
            }
            const start = Math.max(0, at - 20);
            const end = Math.min(message.body.length, at + needle.length + 20);
            results.push({
              message,
              snippet: { start, length: end - start },
              highlights: [{ start: at, length: needle.length }],
            });
          }
        }
        results.sort((a, b) => b.message.sentAt - a.message.sentAt);
        this.#reply(session, id, { results });
        return;
      }
      case 'messages.sendText': {
        const reason = this.sendRefusals.get(params.conversationId);
        if (reason) {
          this.#error(session, id, 'PRECONDITION_FAILED', reason);
          return;
        }
        const message = makeMessage(params.conversationId, {
          direction: 'outgoing',
          body: params.body || null,
          attachments: (params.attachmentUploadIds ?? []).map(uploadId => {
            const upload = this.uploads.get(uploadId);
            return {
              contentType: upload.contentType,
              size: upload.size,
              fileName: upload.fileName ?? null,
              width: null,
              height: null,
              state: 'ready',
              hasThumbnail: false,
              isVoiceMessage: false,
              isGif: false,
              caption: null,
              blurHash: null,
            };
          }),
          read: null,
          sendStatus: 'sending',
          authorConversationId: null,
          quote: this.#quoteOf(params.quoteMessageId),
        });
        this.messages.get(params.conversationId)?.push(message);
        this.#reply(session, id, { message });
        return;
      }
      case 'attachments.uploadBegin': {
        const uploadId = randomUUID();
        this.uploads.set(uploadId, { ...params, bytes: [] });
        this.#reply(session, id, { uploadId });
        return;
      }
      case 'attachments.uploadChunk': {
        const upload = this.uploads.get(params.uploadId);
        upload.bytes.push(Buffer.from(params.data, 'base64'));
        const received = Buffer.concat(upload.bytes).length;
        this.#reply(session, id, {
          received,
          complete: received === upload.size,
        });
        return;
      }
      case 'messages.forward':
      case 'polls.send':
        this.#reply(session, id, {
          results: params.conversationIds.map(conversationId => {
            const reason = this.sendRefusals.get(conversationId) ?? null;
            return { conversationId, ok: reason === null, reason };
          }),
        });
        return;
      case 'contacts.list': {
        this.#reply(session, id, {
          contacts: this.contacts.filter(
            c => !params.forGroup || !c.noteToSelf
          ),
        });
        return;
      }
      case 'conversations.find': {
        const found = this.findable.get(params.query);
        if (!found) {
          this.#error(session, id, 'NOT_FOUND', undefined);
          return;
        }
        this.#reply(session, id, { conversation: found });
        return;
      }
      case 'conversations.open': {
        const contact = this.contacts.find(
          c => c.conversationId === params.conversationId
        );
        if (!contact) {
          this.#error(session, id, 'NOT_FOUND', undefined);
          return;
        }
        const conversation = makeConversation({
          id: contact.conversationId,
          title: contact.title,
          lastActivityAt: null,
        });
        this.messages.set(
          conversation.id,
          this.messages.get(conversation.id) ?? []
        );
        this.#reply(session, id, { conversation });
        return;
      }
      case 'groups.create': {
        const conversation = makeConversation({
          title: params.name,
          type: 'group',
          memberCount: params.memberIds.length + 1,
        });
        this.conversations.push(conversation);
        this.messages.set(conversation.id, []);
        this.#reply(session, id, { conversation });
        return;
      }
      case 'messages.locateQuote': {
        const found = this.quoteLocations.get(params.messageId);
        if (!found) {
          this.#error(session, id, 'NOT_FOUND', undefined);
          return;
        }
        this.#reply(session, id, found);
        return;
      }
      case 'conversations.getDetails': {
        const details = this.details.get(params.conversationId);
        if (!details) {
          this.#error(session, id, 'NOT_FOUND', undefined);
          return;
        }
        this.#reply(session, id, { details });
        return;
      }
      case 'groups.update':
      case 'conversations.update':
      case 'conversations.setTyping':
      case 'messages.markRead':
      case 'messages.react':
      case 'messages.edit':
      case 'messages.delete':
      case 'polls.vote':
      case 'polls.end':
        this.#reply(session, id, {});
        return;
      case 'attachments.read': {
        let key = `${params.messageId}:${params.index}`;
        if (params.sticker) {
          key = `${params.messageId}:sticker`;
        } else if (params.preview !== undefined) {
          key = `${params.messageId}:preview${params.preview}`;
        }
        const file = this.attachments.get(key);
        if (!file) {
          this.#error(session, id, 'NOT_FOUND');
          return;
        }
        this.#reply(session, id, {
          contentType: file.contentType,
          size: file.bytes.length,
          offset: params.offset,
          data: file.bytes
            .subarray(params.offset, params.offset + params.length)
            .toString('base64'),
        });
        return;
      }
      case 'attachments.getThumbnail':
        this.#reply(session, id, {
          contentType: 'image/webp',
          width: 1,
          height: 1,
          data: (this.thumbnailBytes ?? Buffer.from('thumb')).toString(
            'base64'
          ),
        });
        return;
      case 'chatFolders.list':
        this.#reply(session, id, { folders: this.chatFolders ?? [] });
        return;
      case 'media.list': {
        // Newest first; a cursor is the index of the next message.
        const list = [...(this.messages.get(params.conversationId) ?? [])].sort(
          (a, b) => b.sentAt - a.sentAt
        );
        const start = params.cursor ? Number(params.cursor.split('.')[0]) : 0;
        const kindOf = a => {
          const type = a.contentType.split('/')[0];
          if (a.isVoiceMessage || type === 'audio') {
            return 'audio';
          }
          return type === 'image' || type === 'video' ? 'media' : 'files';
        };
        const items = [];
        const messages = [];
        let next = null;
        for (let i = start; i < list.length; i += 1) {
          const m = list[i];
          const found =
            params.kind === 'links'
              ? (m.previews ?? []).map((_, index) => index)
              : (m.attachments ?? []).flatMap((a, index) =>
                  kindOf(a) === params.kind ? [index] : []
                );
          if (found.length === 0) {
            continue;
          }
          if (items.length + found.length > (params.limit ?? 50)) {
            next = `${i}.0`;
            break;
          }
          items.push(...found.map(index => ({ messageId: m.id, index })));
          messages.push(m);
        }
        this.#reply(session, id, { items, messages, nextCursor: next });
        return;
      }
      case 'linkPreviews.fetch': {
        const url = (params.text.match(/https:\/\/\S+/g) ?? []).find(
          link => !(params.exclude ?? []).includes(link)
        );
        this.#reply(session, id, {
          preview:
            url && this.linkPreviews.has(url)
              ? { url, ...this.linkPreviews.get(url) }
              : null,
        });
        return;
      }
      case 'attachments.download':
        this.#reply(session, id, {});
        return;
      case 'reactions.getPreferred':
        this.#reply(session, id, {
          emoji: this.reactionEmoji,
          recent: this.recentEmoji,
        });
        return;
      case 'emoji.markUsed':
        this.recentEmoji = [
          params.emoji,
          ...this.recentEmoji.filter(e => e !== params.emoji),
        ];
        this.#reply(session, id, {});
        return;
      case 'emoji.getCatalog':
        this.#reply(session, id, { categories: this.emojiCatalog });
        return;
      case 'conversations.getAvatar': {
        const avatar = this.avatars.get(params.conversationId);
        if (avatar) {
          this.#reply(session, id, avatar);
        } else {
          this.#error(session, id, 'NOT_FOUND');
        }
        return;
      }
      case 'session.disconnect':
        this.#reply(session, id, {});
        session.socket.end();
        return;
      default:
        this.#error(session, id, 'UNSUPPORTED_METHOD');
    }
  }
}
