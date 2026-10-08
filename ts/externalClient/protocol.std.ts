// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

// Wire protocol for local external clients. See
// docs/external-client-architecture.md. Everything in this file is part of
// the public, versioned contract: change it only additively within a version.

export const PROTOCOL_NAME = 'signal-external-client';
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<number> = [1];

export const LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxConnections: 8,
  maxRequestIdLength: 64,
  maxMethodLength: 64,
  maxClientNameLength: 64,
  maxClientVersionLength: 32,
  maxOfferedVersions: 8,
  maxOutstandingRequests: 16,
  handshakeTimeoutMs: 10_000,
  maxConversationPage: 500,
  defaultConversationPage: 100,
  maxMessagePage: 100,
  defaultMessagePage: 50,
} as const;
export type LimitsType = { readonly [K in keyof typeof LIMITS]: number };

// The capability vocabulary. A client must be granted a capability before
// any method requiring it will run.
export const Capability = {
  ConversationsRead: 'conversations.read',
  MessagesRead: 'messages.read',
  MessagesSend: 'messages.send',
  MessagesReact: 'messages.react',
  MessagesMarkRead: 'messages.markRead',
  AttachmentsRead: 'attachments.read',
  TypingRead: 'typing.read',
  TypingSend: 'typing.send',
  ContactsRead: 'contacts.read',
  ProfileRead: 'profile.read',
} as const;
export type CapabilityType = (typeof Capability)[keyof typeof Capability];
export const ALL_CAPABILITIES: ReadonlyArray<CapabilityType> =
  Object.values(Capability);

// Capabilities this build can actually serve. `hello` advertises these, and
// clients may only request these.
export const IMPLEMENTED_CAPABILITIES: ReadonlyArray<CapabilityType> = [
  Capability.ConversationsRead,
  Capability.MessagesRead,
];

export const ErrorCode = {
  InvalidRequest: 'INVALID_REQUEST',
  UnsupportedVersion: 'UNSUPPORTED_VERSION',
  UnsupportedMethod: 'UNSUPPORTED_METHOD',
  UnsupportedCapability: 'UNSUPPORTED_CAPABILITY',
  NotAuthorized: 'NOT_AUTHORIZED',
  PermissionDenied: 'PERMISSION_DENIED',
  NotFound: 'NOT_FOUND',
  InvalidArgument: 'INVALID_ARGUMENT',
  NotReady: 'NOT_READY',
  PreconditionFailed: 'PRECONDITION_FAILED',
  RateLimited: 'RATE_LIMITED',
  InternalError: 'INTERNAL_ERROR',
} as const;
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// Fixed, human-readable text for errors returned by data methods. The text
// depends only on the code, so it can never carry internal detail.
export const ERROR_MESSAGES: Readonly<Record<ErrorCodeType, string>> = {
  INVALID_REQUEST: 'Invalid request',
  UNSUPPORTED_VERSION: 'Unsupported protocol version',
  UNSUPPORTED_METHOD: 'Unsupported method',
  UNSUPPORTED_CAPABILITY: 'Unsupported capability',
  NOT_AUTHORIZED: 'Not authorized',
  PERMISSION_DENIED: 'Permission denied',
  NOT_FOUND: 'Not found',
  INVALID_ARGUMENT: 'Invalid argument',
  NOT_READY: 'Signal is not ready',
  PRECONDITION_FAILED: 'Precondition failed',
  RATE_LIMITED: 'Rate limited',
  INTERNAL_ERROR: 'Internal error',
};

export const Method = {
  Hello: 'session.hello',
  Authenticate: 'session.authenticate',
  RequestAuthorization: 'authorization.request',
  GetStatus: 'session.getStatus',
  Disconnect: 'session.disconnect',
  ConversationsList: 'conversations.list',
  ConversationsGet: 'conversations.get',
  MessagesList: 'messages.list',
  MessagesGet: 'messages.get',
} as const;
export type MethodType = (typeof Method)[keyof typeof Method];

// Methods served by the renderer, and the capability each one requires.
export const SERVICE_METHOD_CAPABILITIES = {
  [Method.ConversationsList]: Capability.ConversationsRead,
  [Method.ConversationsGet]: Capability.ConversationsRead,
  [Method.MessagesList]: Capability.MessagesRead,
  [Method.MessagesGet]: Capability.MessagesRead,
} as const satisfies Partial<Record<MethodType, CapabilityType>>;
export type ServiceMethodType = keyof typeof SERVICE_METHOD_CAPABILITIES;

export function isServiceMethod(method: string): method is ServiceMethodType {
  return Object.hasOwn(SERVICE_METHOD_CAPABILITIES, method);
}

export const SessionStatus = {
  Ready: 'ready',
  Starting: 'starting',
  Unlinked: 'unlinked',
  Unavailable: 'unavailable',
} as const;
export type SessionStatusType =
  (typeof SessionStatus)[keyof typeof SessionStatus];

const requestIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxRequestIdLength)
  .regex(/^[A-Za-z0-9._:-]+$/);

// Unpadded base64url. 32 bytes encode to 43 characters, a 64-byte Ed25519
// signature to 86.
const base64UrlSchema = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/);
export const keySchema = base64UrlSchema(32);
export const nonceSchema = base64UrlSchema(32);
export const signatureSchema = base64UrlSchema(64);

// Every inbound message is a request. Params are validated per method after
// the envelope is accepted.
export const requestEnvelopeSchema = z
  .object({
    id: requestIdSchema,
    method: z.string().min(1).max(LIMITS.maxMethodLength),
    params: z.unknown().optional(),
  })
  .strict();
export type RequestEnvelopeType = z.infer<typeof requestEnvelopeSchema>;

export const helloParamsSchema = z
  .object({
    protocol: z.literal(PROTOCOL_NAME),
    versions: z
      .array(z.number().int().min(1).max(1000))
      .min(1)
      .max(LIMITS.maxOfferedVersions),
    client: z
      .object({
        name: z.string().min(1).max(LIMITS.maxClientNameLength),
        version: z.string().min(1).max(LIMITS.maxClientVersionLength),
      })
      .strict(),
    // Random bytes chosen by the client. Signal signs them, so a process
    // squatting on the endpoint cannot replay an old handshake.
    clientNonce: nonceSchema,
  })
  .strict();
export type HelloParamsType = z.infer<typeof helloParamsSchema>;

export type HelloResultType = Readonly<{
  protocol: typeof PROTOCOL_NAME;
  protocolVersion: number;
  signalVersion: string;
  sessionId: string;
  capabilities: ReadonlyArray<CapabilityType>;
  features: Readonly<{
    'authentication.required': boolean;
    'calling.available': boolean;
  }>;
  // Sign this to authenticate (see auth.node.ts for the exact transcript).
  challenge: string;
  server: Readonly<{
    publicKey: string;
    signature: string;
  }>;
}>;

export const authenticateParamsSchema = z
  .object({
    publicKey: keySchema,
    signature: signatureSchema,
  })
  .strict();

const capabilitySchema = z.enum(
  ALL_CAPABILITIES as [CapabilityType, ...Array<CapabilityType>]
);

export const requestAuthorizationParamsSchema = z
  .object({
    publicKey: keySchema,
    signature: signatureSchema,
    // Shown to the user, so no control, format or bidi-override characters.
    displayName: z
      .string()
      .min(1)
      .max(LIMITS.maxClientNameLength)
      .regex(/^[^\p{C}]+$/u),
    capabilities: z.array(capabilitySchema).min(1).max(ALL_CAPABILITIES.length),
  })
  .strict();

export type AuthorizationResultType = Readonly<{
  capabilities: ReadonlyArray<CapabilityType>;
}>;

const conversationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

export const conversationsListParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(LIMITS.maxConversationPage).optional(),
    cursor: z
      .string()
      .max(16)
      .regex(/^[0-9]+$/)
      .optional(),
  })
  .strict();

export const conversationsGetParamsSchema = z
  .object({
    conversationId: conversationIdSchema,
  })
  .strict();

// Signal message ids are UUIDs; accept the same conservative shape as
// conversation ids.
const messageIdSchema = conversationIdSchema;

export const messagesListParamsSchema = z
  .object({
    conversationId: conversationIdSchema,
    limit: z.number().int().min(1).max(LIMITS.maxMessagePage).optional(),
    // Opaque to clients: pass back `nextCursor` to page further back.
    cursor: messageIdSchema.optional(),
  })
  .strict();

export const messagesGetParamsSchema = z
  .object({
    messageId: messageIdSchema,
  })
  .strict();

export const SERVICE_PARAM_SCHEMAS = {
  [Method.ConversationsList]: conversationsListParamsSchema,
  [Method.ConversationsGet]: conversationsGetParamsSchema,
  [Method.MessagesList]: messagesListParamsSchema,
  [Method.MessagesGet]: messagesGetParamsSchema,
} as const satisfies Record<ServiceMethodType, z.ZodType>;

export type ConversationsListParamsType = z.infer<
  typeof conversationsListParamsSchema
>;
export type ConversationsGetParamsType = z.infer<
  typeof conversationsGetParamsSchema
>;

// Public conversation DTO. Never add internal identifiers (service ids, group
// ids, profile keys, e164s) or storage paths here.
export type ConversationDTO = Readonly<{
  id: string;
  type: 'direct' | 'group';
  title: string;
  unreadCount: number;
  unreadMentionsCount: number;
  markedUnread: boolean;
  lastActivityAt: number | null;
  muted: boolean;
  archived: boolean;
  pinned: boolean;
  blocked: boolean;
  noteToSelf: boolean;
  messageRequestPending: boolean;
  memberCount: number | null;
}>;

export type ConversationsListResultType = Readonly<{
  conversations: ReadonlyArray<ConversationDTO>;
  nextCursor: string | null;
}>;

export type MessagesListParamsType = z.infer<typeof messagesListParamsSchema>;
export type MessagesGetParamsType = z.infer<typeof messagesGetParamsSchema>;

// What a message shows. `text` covers any message with a body and/or
// attachments; everything Signal can render but this API does not yet
// describe is `unsupported`.
export const MessageKind = {
  Text: 'text',
  Sticker: 'sticker',
  ViewOnce: 'viewOnce',
  Deleted: 'deleted',
  Unsupported: 'unsupported',
} as const;
export type MessageKindType = (typeof MessageKind)[keyof typeof MessageKind];

export type MentionDTO = Readonly<{
  start: number;
  length: number;
  // Null when the mentioned person has no conversation on this device.
  conversationId: string | null;
}>;

// Metadata only. Attachment content and storage paths never cross the bridge
// through this type.
export type AttachmentMetadataDTO = Readonly<{
  contentType: string;
  size: number;
  fileName: string | null;
  width: number | null;
  height: number | null;
}>;

export type QuoteDTO = Readonly<{
  authorConversationId: string | null;
  sentAt: number | null;
  text: string | null;
}>;

// Public message DTO. Never add service ids, e164s, keys, attachment paths,
// or raw protobufs here.
export type MessageDTO = Readonly<{
  id: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  kind: MessageKindType;
  authorConversationId: string | null;
  sentAt: number;
  receivedAt: number | null;
  body: string | null;
  // True when `body` is the first part of a long message.
  bodyTruncated: boolean;
  mentions: ReadonlyArray<MentionDTO>;
  attachments: ReadonlyArray<AttachmentMetadataDTO>;
  quote: QuoteDTO | null;
  edited: boolean;
  // Disappearing messages: clients must discard the message by this time.
  expiresAt: number | null;
  // Incoming only; null for outgoing.
  read: boolean | null;
}>;

export type MessagesListResultType = Readonly<{
  // Oldest first.
  messages: ReadonlyArray<MessageDTO>;
  nextCursor: string | null;
}>;

export type ErrorType = Readonly<{
  code: ErrorCodeType;
  message: string;
}>;

export type ResponseType =
  | Readonly<{ id: string; result: unknown }>
  | Readonly<{ id: string | null; error: ErrorType }>;

export function negotiateVersion(
  offered: ReadonlyArray<number>
): number | undefined {
  let best: number | undefined;
  for (const version of offered) {
    if (
      SUPPORTED_PROTOCOL_VERSIONS.includes(version) &&
      (best === undefined || version > best)
    ) {
      best = version;
    }
  }
  return best;
}

export function makeError(
  id: string | null,
  code: ErrorCodeType,
  message: string
): ResponseType {
  return { id, error: { code, message } };
}
