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
  attachmentsUploadChunkParamsSchema,
  helloParamsSchema,
  messagesForwardParamsSchema,
  messagesSendTextParamsSchema,
  negotiateVersion,
  pollsSendParamsSchema,
  pollsVoteParamsSchema,
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
  });
});
