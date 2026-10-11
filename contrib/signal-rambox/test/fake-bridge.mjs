// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for Signal's bridge, enough for signal-rambox's tests: real
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
  grants = new Map();
  conversations = [];
  messages = new Map();
  // conversationId -> [{ conversationId, author }]
  members = new Map();
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
  ];
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
      case 'conversations.getMembers':
        this.#reply(session, id, {
          members: this.members.get(params.conversationId) ?? [],
        });
        return;
      case 'messages.list':
        this.#reply(session, id, {
          messages: this.messages.get(params.conversationId) ?? [],
          nextCursor: null,
        });
        return;
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
        });
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
