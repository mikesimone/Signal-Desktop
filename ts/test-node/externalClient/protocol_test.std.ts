// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import type { ZodType } from 'zod';

import { safeParseUnknown } from '../../util/schemas.std.ts';
import {
  ALL_CAPABILITIES,
  LIMITS,
  MAX_ATTACHMENT_CHUNK_BYTES,
  PROTOCOL_NAME,
  attachmentsUploadBeginParamsSchema,
  attachmentsUploadChunkParamsSchema,
  groupsUpdateParamsSchema,
  helloParamsSchema,
  messagesEditParamsSchema,
  messagesForwardParamsSchema,
  messagesSendStickerParamsSchema,
  linkPreviewsFetchParamsSchema,
  mediaListParamsSchema,
  chatFoldersListParamsSchema,
  messagesSearchParamsSchema,
  messagesSendTextParamsSchema,
  negotiateVersion,
  MAX_FORMATTING_RANGES,
  MAX_MENTIONS,
  pollsSendParamsSchema,
  pollsVoteParamsSchema,
  settingsSetParamsSchema,
  profileSetParamsSchema,
  conversationsUpdateParamsSchema,
  profileSetAvatarParamsSchema,
  PROFILE_ABOUT_MAX_BYTES,
  MAX_PROFILE_AVATAR_BYTES,
  requestEnvelopeSchema,
} from '../../externalClient/protocol.std.ts';

// The schemas guard untrusted input, so tests feed them `unknown` values.
function accepts(schema: ZodType, value: unknown): boolean {
  return safeParseUnknown(schema, value).success;
}

const validHello: unknown = {
  protocol: PROTOCOL_NAME,
  versions: [1],
  client: { name: 'test', version: '1.0' },
  clientNonce: 'A'.repeat(43),
};

function hello(overrides: Record<string, unknown>): unknown {
  return { ...(validHello as object), ...overrides };
}

describe('externalClient/protocol', () => {
  describe('negotiateVersion', () => {
    it('picks the highest common version', () => {
      assert.strictEqual(negotiateVersion([3, 1, 2]), 1);
    });

    it('returns undefined with no common version', () => {
      assert.isUndefined(negotiateVersion([2, 99]));
    });
  });

  describe('requestEnvelopeSchema', () => {
    it('accepts a minimal request', () => {
      assert.isTrue(
        accepts(requestEnvelopeSchema, { id: 'r1', method: 'session.hello' })
      );
    });

    it('rejects unknown keys', () => {
      assert.isFalse(
        accepts(requestEnvelopeSchema, {
          id: 'r1',
          method: 'session.hello',
          extra: true,
        })
      );
    });

    it('rejects a __proto__ key from JSON input', () => {
      const input: unknown = JSON.parse(
        '{"id":"r1","method":"m","__proto__":{"polluted":true}}'
      );
      assert.isFalse(accepts(requestEnvelopeSchema, input));
      assert.isUndefined(({} as Record<string, unknown>).polluted);
    });

    it('rejects over-long and odd request ids', () => {
      for (const id of [
        '',
        'x'.repeat(LIMITS.maxRequestIdLength + 1),
        'has space',
        '../etc',
      ]) {
        assert.isFalse(accepts(requestEnvelopeSchema, { id, method: 'm' }), id);
      }
    });

    it('rejects non-object input', () => {
      for (const input of [null, 1, 'str', [], true]) {
        assert.isFalse(accepts(requestEnvelopeSchema, input));
      }
    });
  });

  describe('helloParamsSchema', () => {
    it('accepts a valid hello', () => {
      assert.isTrue(accepts(helloParamsSchema, validHello));
    });

    it('requires a well-formed client nonce', () => {
      assert.isFalse(
        accepts(helloParamsSchema, hello({ clientNonce: 'short' }))
      );
      assert.isFalse(
        accepts(helloParamsSchema, hello({ clientNonce: '+'.repeat(43) }))
      );
    });

    it('rejects a different protocol name', () => {
      assert.isFalse(
        accepts(helloParamsSchema, hello({ protocol: 'something-else' }))
      );
    });

    it('bounds the offered versions and client strings', () => {
      assert.isFalse(
        accepts(
          helloParamsSchema,
          hello({
            versions: new Array(LIMITS.maxOfferedVersions + 1).fill(1),
          })
        )
      );
      assert.isFalse(accepts(helloParamsSchema, hello({ versions: [] })));
      assert.isFalse(
        accepts(
          helloParamsSchema,
          hello({
            client: {
              name: 'x'.repeat(LIMITS.maxClientNameLength + 1),
              version: '1',
            },
          })
        )
      );
    });
  });

  it('advertises no calling capability', () => {
    assert.notInclude(
      ALL_CAPABILITIES as ReadonlyArray<string>,
      'calls.control'
    );
  });

  describe('fork: sending attachments and forwarding', () => {
    const conversationId = '0b3f5c2e-1d4a-4c8e-9f00-123456789abc';
    const uploadId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    it('needs a body or attachments', () => {
      const schema = messagesSendTextParamsSchema;
      assert.isTrue(accepts(schema, { conversationId, body: 'hi' }));
      assert.isFalse(accepts(schema, { conversationId, body: '' }));
      assert.isTrue(
        accepts(schema, {
          conversationId,
          body: '',
          attachmentUploadIds: [uploadId],
        })
      );
      assert.isFalse(
        accepts(schema, { conversationId, body: '', attachmentUploadIds: [] })
      );
    });

    it('takes voice notes as Signal records them', () => {
      const schema = attachmentsUploadBeginParamsSchema;
      const voiceNote = { durationSeconds: 3.5, waveform: [0, 128, 255] };
      assert.isTrue(
        accepts(schema, { contentType: 'audio/mpeg', size: 10, voiceNote })
      );
      assert.isFalse(
        accepts(schema, { contentType: 'image/png', size: 10, voiceNote })
      );
      assert.isFalse(
        accepts(schema, {
          contentType: 'audio/mpeg',
          fileName: 'a.mp3',
          size: 10,
          voiceNote,
        })
      );
      assert.isFalse(
        accepts(schema, {
          contentType: 'audio/mpeg',
          size: 10,
          voiceNote: { ...voiceNote, waveform: [256] },
        })
      );
      assert.isFalse(
        accepts(schema, {
          contentType: 'audio/mpeg',
          size: 10,
          voiceNote: { ...voiceNote, waveform: new Array(101).fill(1) },
        })
      );
    });

    it('keeps upload chunks inside a frame', () => {
      const max = Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES / 3) * 4;
      const ok = { uploadId, offset: 0, data: 'A'.repeat(max) };
      assert.isTrue(accepts(attachmentsUploadChunkParamsSchema, ok));
      assert.isFalse(
        accepts(attachmentsUploadChunkParamsSchema, {
          ...ok,
          data: 'A'.repeat(max + 4),
        })
      );
    });

    it('forwards to far more than five chats', () => {
      assert.isTrue(
        accepts(messagesForwardParamsSchema, {
          messageId: conversationId,
          conversationIds: Array.from({ length: 300 }, () => conversationId),
        })
      );
    });

    it('forwards an edited text with mentions and fewer attachments', () => {
      const forward = {
        messageId: conversationId,
        conversationIds: [conversationId],
      };
      assert.isTrue(
        accepts(messagesForwardParamsSchema, {
          ...forward,
          edit: {
            body: 'look \uFFFC',
            mentions: [{ start: 5, conversationId }],
            formatting: [{ start: 0, length: 4, style: 'bold' }],
            attachmentIndexes: [0, 2],
          },
        })
      );
      assert.isFalse(
        accepts(messagesForwardParamsSchema, {
          ...forward,
          edit: { body: 'x', attachmentIndexes: [-1] },
        })
      );
      assert.isFalse(
        accepts(messagesForwardParamsSchema, {
          ...forward,
          edit: { body: 'x', attachmentIndexes: [], quote: 'y' },
        })
      );
    });

    it("keeps polls inside Signal's limits", () => {
      const poll = {
        conversationIds: [conversationId],
        question: 'Lunch?',
        options: ['Tacos', 'Pho'],
        allowMultiple: false,
      };
      assert.isTrue(accepts(pollsSendParamsSchema, poll));
      assert.isFalse(
        accepts(pollsSendParamsSchema, { ...poll, options: ['Tacos'] })
      );
      assert.isFalse(
        accepts(pollsSendParamsSchema, {
          ...poll,
          options: Array.from({ length: 11 }, (_, i) => `option ${i}`),
        })
      );
      assert.isFalse(
        accepts(pollsSendParamsSchema, { ...poll, question: 'x'.repeat(101) })
      );
      assert.isFalse(
        accepts(pollsSendParamsSchema, { ...poll, options: ['Tacos', '  '] })
      );
      // Emoji count as one character each, as in Signal's dialog.
      assert.isTrue(
        accepts(pollsSendParamsSchema, { ...poll, question: '👍🏽'.repeat(100) })
      );
      assert.isTrue(
        accepts(pollsVoteParamsSchema, {
          messageId: conversationId,
          optionIndexes: [],
        })
      );
      assert.isFalse(
        accepts(pollsVoteParamsSchema, {
          messageId: conversationId,
          optionIndexes: [10],
        })
      );
    });

    it('takes mentions on sends and edits, within bounds', () => {
      const mention = { start: 0, conversationId };
      assert.isTrue(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: '\uFFFC hi',
          mentions: [mention],
        })
      );
      assert.isFalse(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: '\uFFFC hi',
          mentions: [{ ...mention, aci: 'x' }],
        })
      );
      assert.isFalse(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'hi',
          mentions: Array.from({ length: MAX_MENTIONS + 1 }, () => mention),
        })
      );
    });

    it('takes only known settings with values of their own kind', () => {
      assert.isTrue(
        accepts(settingsSetParamsSchema, { key: 'readReceipts', value: false })
      );
      assert.isTrue(
        accepts(settingsSetParamsSchema, {
          key: 'emojiSkinTone',
          value: '1F3FD',
        })
      );
      assert.isFalse(
        accepts(settingsSetParamsSchema, { key: 'readReceipts', value: 'no' })
      );
      assert.isFalse(
        accepts(settingsSetParamsSchema, { key: 'emojiSkinTone', value: 'x' })
      );
      assert.isFalse(
        accepts(settingsSetParamsSchema, { key: 'deleteAllData', value: true })
      );
      assert.isFalse(
        accepts(settingsSetParamsSchema, {
          key: 'disappearingMessagesSeconds',
          value: -1,
        })
      );
    });

    it('takes profile fields and a photo, nothing else', () => {
      const profile = {
        firstName: 'Mike',
        familyName: '',
        aboutText: 'Hi',
        aboutEmoji: '',
      };
      assert.isTrue(accepts(profileSetParamsSchema, profile));
      assert.isFalse(
        accepts(profileSetParamsSchema, { ...profile, username: 'mike.01' })
      );
      assert.isFalse(
        accepts(profileSetParamsSchema, {
          ...profile,
          aboutText: 'x'.repeat(PROFILE_ABOUT_MAX_BYTES + 1),
        })
      );
      assert.isTrue(accepts(profileSetAvatarParamsSchema, { data: null }));
      assert.isTrue(accepts(profileSetAvatarParamsSchema, { data: 'AAAA' }));
      assert.isFalse(
        accepts(profileSetAvatarParamsSchema, {
          data: 'A'.repeat(Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3) * 4 + 4),
        })
      );
      assert.isTrue(
        accepts(settingsSetParamsSchema, {
          key: 'storiesEnabled',
          value: true,
        })
      );
    });

    it("takes Signal's chat menu actions only", () => {
      const ok = (change: unknown) =>
        accepts(conversationsUpdateParamsSchema, { conversationId, change });
      assert.isTrue(ok({ action: 'mute', durationMs: 3_600_000 }));
      assert.isTrue(ok({ action: 'mute', durationMs: null }));
      assert.isTrue(ok({ action: 'pin', value: true }));
      assert.isTrue(ok({ action: 'disappearingMessages', seconds: 0 }));
      assert.isTrue(ok({ action: 'delete' }));
      assert.isFalse(ok({ action: 'mute', durationMs: 5 }));
      assert.isFalse(ok({ action: 'leaveGroup' }));
      assert.isFalse(ok({ action: 'disappearingMessages', seconds: -1 }));
    });

    it('lists media by kind with an opaque cursor', () => {
      const conversationId = '0b9e2c1a-1111-4222-8333-944455556666';
      assert.isTrue(
        accepts(mediaListParamsSchema, { conversationId, kind: 'media' })
      );
      assert.isTrue(
        accepts(mediaListParamsSchema, {
          conversationId,
          kind: 'links',
          cursor: '1700000000000.1700000000001',
        })
      );
      assert.isFalse(
        accepts(mediaListParamsSchema, { conversationId, kind: 'stickers' })
      );
      assert.isFalse(
        accepts(mediaListParamsSchema, {
          conversationId,
          kind: 'files',
          cursor: "1' OR 1=1",
        })
      );
    });

    it('lists chat folders, and searches unread messages only', () => {
      assert.isTrue(accepts(chatFoldersListParamsSchema, {}));
      assert.isFalse(accepts(chatFoldersListParamsSchema, { all: true }));
      assert.isTrue(
        accepts(messagesSearchParamsSchema, { query: 'hi', onlyUnread: true })
      );
      assert.isFalse(
        accepts(messagesSearchParamsSchema, { query: 'hi', onlyUnread: 'yes' })
      );
    });

    it('takes text for a link preview and a preview url on send', () => {
      assert.isTrue(
        accepts(linkPreviewsFetchParamsSchema, {
          text: 'see https://example.com',
          exclude: ['https://other.example'],
        })
      );
      assert.isFalse(
        accepts(linkPreviewsFetchParamsSchema, { text: 'x', url: 'y' })
      );
      assert.isFalse(
        accepts(linkPreviewsFetchParamsSchema, {
          text: 'x',
          exclude: ['x'.repeat(3000)],
        })
      );
      assert.isTrue(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'see https://example.com',
          linkPreviewUrl: 'https://example.com',
        })
      );
    });

    it('takes a sticker by pack and id', () => {
      assert.isTrue(
        accepts(messagesSendStickerParamsSchema, {
          conversationId,
          packId: '9acc9e8aba563d26a4994e69263e3b25',
          stickerId: 3,
        })
      );
      assert.isFalse(
        accepts(messagesSendStickerParamsSchema, {
          conversationId,
          packId: '../etc',
          stickerId: 3,
        })
      );
      assert.isFalse(
        accepts(messagesSendStickerParamsSchema, {
          conversationId,
          packId: 'abcd',
          stickerId: -1,
        })
      );
    });

    it('takes formatting on sends and edits, only Signal styles', () => {
      const range = { start: 0, length: 2, style: 'bold' };
      assert.isTrue(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'hi',
          formatting: [range, { ...range, style: 'spoiler' }],
        })
      );
      assert.isTrue(
        accepts(messagesEditParamsSchema, {
          messageId: conversationId,
          body: 'hi',
          formatting: [{ ...range, style: 'monospace' }],
        })
      );
      assert.isFalse(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'hi',
          formatting: [{ ...range, style: 'underline' }],
        })
      );
      assert.isFalse(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'hi',
          formatting: [{ ...range, length: 0 }],
        })
      );
      assert.isFalse(
        accepts(messagesSendTextParamsSchema, {
          conversationId,
          body: 'hi',
          formatting: Array.from(
            { length: MAX_FORMATTING_RANGES + 1 },
            () => range
          ),
        })
      );
    });
    it("takes Signal's group changes only", () => {
      const update = (change: unknown) =>
        accepts(groupsUpdateParamsSchema, { conversationId, change });
      assert.isTrue(update({ action: 'setInfo', name: 'Books' }));
      assert.isTrue(update({ action: 'setInfo', avatar: null }));
      assert.isTrue(update({ action: 'setInfo', description: '' }));
      assert.isFalse(update({ action: 'setInfo', name: '' }));
      assert.isTrue(
        update({ action: 'addMembers', memberIds: [conversationId] })
      );
      assert.isFalse(update({ action: 'addMembers', memberIds: [] }));
      assert.isTrue(
        update({ action: 'setAdmin', memberId: conversationId, admin: true })
      );
      assert.isFalse(update({ action: 'setAdmin', memberId: conversationId }));
      assert.isTrue(update({ action: 'groupLink', enabled: false }));
      assert.isTrue(update({ action: 'permissions', sendMessages: 'admins' }));
      assert.isFalse(update({ action: 'permissions', addMembers: 'nobody' }));
      assert.isTrue(update({ action: 'leave' }));
      assert.isFalse(update({ action: 'ban', memberId: conversationId }));
      assert.isFalse(
        accepts(groupsUpdateParamsSchema, {
          conversationId,
          change: { action: 'leave' },
          extra: 1,
        })
      );
    });
  });
});
