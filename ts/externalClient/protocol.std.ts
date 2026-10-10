// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

// Wire protocol for local external clients. See
// docs/external-client-architecture.md. Everything in this file is part of
// the public, versioned contract: change it only additively within a version.

export const PROTOCOL_NAME = 'signal-external-client';
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<number> = [1];

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
  // Events stop (with `events.dropped`) once this many bytes are waiting to
  // be written to a client.
  maxEventBacklogBytes: 1024 * 1024,
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
  // Let the app show Signal's message notifications instead of Signal.
  NotificationsManage: 'notifications.manage',
} as const;
export type CapabilityType = (typeof Capability)[keyof typeof Capability];
export const ALL_CAPABILITIES: ReadonlyArray<CapabilityType> =
  Object.values(Capability);

// Capabilities this build can actually serve. `hello` advertises these, and
// clients may only request these.
export const IMPLEMENTED_CAPABILITIES: ReadonlyArray<CapabilityType> = [
  Capability.ConversationsRead,
  Capability.MessagesRead,
  Capability.MessagesSend,
  Capability.MessagesMarkRead,
  Capability.MessagesReact,
  Capability.AttachmentsRead,
  Capability.NotificationsManage,
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
  EventsSubscribe: 'events.subscribe',
  EventsUnsubscribe: 'events.unsubscribe',
  MessagesSendText: 'messages.sendText',
  MessagesMarkRead: 'messages.markRead',
  NotificationsSetHandled: 'notifications.setHandled',
  // Fork additions (not in the upstream proposal).
  ConversationsGetAvatar: 'conversations.getAvatar',
  MessagesReact: 'messages.react',
  ReactionsGetPreferred: 'reactions.getPreferred',
  AttachmentsGetThumbnail: 'attachments.getThumbnail',
  AttachmentsRead: 'attachments.read',
  AttachmentsDownload: 'attachments.download',
  MessagesEdit: 'messages.edit',
  MessagesDelete: 'messages.delete',
  AttachmentsUploadBegin: 'attachments.uploadBegin',
  AttachmentsUploadChunk: 'attachments.uploadChunk',
  MessagesForward: 'messages.forward',
} as const;
export type MethodType = (typeof Method)[keyof typeof Method];

// Methods served by the renderer, and the capability each one requires.
export const SERVICE_METHOD_CAPABILITIES = {
  [Method.ConversationsList]: Capability.ConversationsRead,
  [Method.ConversationsGet]: Capability.ConversationsRead,
  [Method.MessagesList]: Capability.MessagesRead,
  [Method.MessagesGet]: Capability.MessagesRead,
  [Method.MessagesSendText]: Capability.MessagesSend,
  [Method.MessagesMarkRead]: Capability.MessagesMarkRead,
  [Method.ConversationsGetAvatar]: Capability.ConversationsRead,
  [Method.MessagesReact]: Capability.MessagesReact,
  [Method.ReactionsGetPreferred]: Capability.MessagesReact,
  [Method.AttachmentsGetThumbnail]: Capability.AttachmentsRead,
  [Method.AttachmentsRead]: Capability.AttachmentsRead,
  [Method.AttachmentsDownload]: Capability.AttachmentsRead,
  [Method.MessagesEdit]: Capability.MessagesSend,
  [Method.MessagesDelete]: Capability.MessagesSend,
  [Method.AttachmentsUploadBegin]: Capability.MessagesSend,
  [Method.AttachmentsUploadChunk]: Capability.MessagesSend,
  [Method.MessagesForward]: Capability.MessagesSend,
} as const satisfies Partial<Record<MethodType, CapabilityType>>;
export type ServiceMethodType = keyof typeof SERVICE_METHOD_CAPABILITIES;

export function isServiceMethod(method: string): method is ServiceMethodType {
  return Object.hasOwn(SERVICE_METHOD_CAPABILITIES, method);
}

// Live updates. A client subscribes to topics, then takes a snapshot with the
// list methods, then applies events as idempotent upserts and removals.
export const EventTopic = {
  Conversations: 'conversations',
  Messages: 'messages',
} as const;
export type EventTopicType = (typeof EventTopic)[keyof typeof EventTopic];
export const ALL_EVENT_TOPICS: ReadonlyArray<EventTopicType> =
  Object.values(EventTopic);

export const EVENT_TOPIC_CAPABILITIES = {
  [EventTopic.Conversations]: Capability.ConversationsRead,
  [EventTopic.Messages]: Capability.MessagesRead,
} as const satisfies Record<EventTopicType, CapabilityType>;

export const EventName = {
  // data: ConversationDTO. Also sent when a conversation becomes listed.
  ConversationUpdated: 'conversation.updated',
  // data: { conversationId }. Also sent when a conversation stops being
  // listed (deleted, blocked into a request, and so on).
  ConversationRemoved: 'conversation.removed',
  // data: MessageDTO
  MessageAdded: 'message.added',
  // data: MessageDTO
  MessageUpdated: 'message.updated',
  // data: { messageId, conversationId }
  MessageRemoved: 'message.removed',
  // data: {}. Signal stopped delivering events to this session, which is
  // now unsubscribed from every topic. Subscribe again and take a new
  // snapshot.
  EventsDropped: 'events.dropped',
} as const;
export type EventNameType = (typeof EventName)[keyof typeof EventName];

// Events Signal broadcasts, and the topic each one belongs to.
export const EVENT_TOPICS = {
  [EventName.ConversationUpdated]: EventTopic.Conversations,
  [EventName.ConversationRemoved]: EventTopic.Conversations,
  [EventName.MessageAdded]: EventTopic.Messages,
  [EventName.MessageUpdated]: EventTopic.Messages,
  [EventName.MessageRemoved]: EventTopic.Messages,
} as const satisfies Partial<Record<EventNameType, EventTopicType>>;
export type BroadcastEventNameType = keyof typeof EVENT_TOPICS;

// Pushed to the client without being asked for. `seq` starts at 1 and grows
// by one for every event on this session, so a client can tell events from
// responses (which always carry `id`) and spot gaps.
export type EventFrameType = Readonly<{
  event: EventNameType;
  seq: number;
  data: unknown;
}>;

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
const nonceSchema = base64UrlSchema(32);
const signatureSchema = base64UrlSchema(64);

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

const eventTopicSchema = z.enum(
  ALL_EVENT_TOPICS as [EventTopicType, ...Array<EventTopicType>]
);

export const eventsSubscribeParamsSchema = z
  .object({
    topics: z.array(eventTopicSchema).min(1).max(ALL_EVENT_TOPICS.length),
  })
  .strict();

export const eventsUnsubscribeParamsSchema = z
  .object({
    // Omit to unsubscribe from everything.
    topics: z
      .array(eventTopicSchema)
      .min(1)
      .max(ALL_EVENT_TOPICS.length)
      .optional(),
  })
  .strict();

export type EventsResultType = Readonly<{
  // Every topic this session is now subscribed to.
  topics: ReadonlyArray<EventTopicType>;
}>;

// Signal's own composer limit (shouldShowInvalidMessageToast).
const MAX_SEND_BODY_LENGTH = 64 * 1024;
// As many as Signal's composer takes.
export const MAX_SEND_ATTACHMENTS = 32;

export const messagesSendTextParamsSchema = z
  .object({
    conversationId: conversationIdSchema,
    body: z.string().max(MAX_SEND_BODY_LENGTH),
    // Reply to this message (it must be in the same conversation), quoting
    // it as Signal's own reply does.
    quoteMessageId: messageIdSchema.optional(),
    // Fork addition: finished uploads (attachments.uploadBegin) to send as
    // the message's attachments; the body is then their caption and may be
    // empty.
    attachmentUploadIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_SEND_ATTACHMENTS)
      .optional(),
  })
  .strict()
  .refine(params => params.body !== '' || params.attachmentUploadIds, {
    message: 'body or attachments required',
  });
export type MessagesSendTextParamsType = z.infer<
  typeof messagesSendTextParamsSchema
>;

export type MessagesSendTextResultType = Readonly<{
  // The new message; it also arrives as `message.added`.
  message: MessageDTO;
}>;

export const messagesMarkReadParamsSchema = z
  .object({
    conversationId: conversationIdSchema,
    // Everything up to and including this message is marked read, exactly as
    // if the user had scrolled to it in Signal.
    upToMessageId: messageIdSchema,
  })
  .strict();
export type MessagesMarkReadParamsType = z.infer<
  typeof messagesMarkReadParamsSchema
>;

export const conversationsGetAvatarParamsSchema = z
  .object({
    conversationId: conversationIdSchema,
  })
  .strict();
export type ConversationsGetAvatarParamsType = z.infer<
  typeof conversationsGetAvatarParamsSchema
>;

// Avatars are decoded inside Signal and re-encoded at this size, so no
// file, path or key crosses the bridge, and frames stay small.
export const AVATAR_SIZE_PX = 128;

export type ConversationsGetAvatarResultType = Readonly<{
  // Matches the conversation's or author's `avatarVersion`.
  avatarVersion: string;
  contentType: 'image/webp' | 'image/png';
  // Base64 (standard alphabet, padded).
  data: string;
}>;

export const messagesReactParamsSchema = z
  .object({
    messageId: messageIdSchema,
    // One emoji, as Signal's reaction picker sends it.
    emoji: z.string().min(1).max(32),
    // True removes this emoji, if it is the user's current reaction.
    remove: z.boolean().optional(),
  })
  .strict();
export type MessagesReactParamsType = z.infer<typeof messagesReactParamsSchema>;

export const reactionsGetPreferredParamsSchema = z.object({}).strict();

export type ReactionsGetPreferredResultType = Readonly<{
  // The user's quick-reaction bar, in order, with their skin tone applied.
  emoji: ReadonlyArray<string>;
}>;

// Fork addition: attachment content. `index` is the position in the
// message's `attachments`; `sticker: true` names the message's sticker
// instead. Content of view-once, deleted and erased messages never crosses.
const attachmentTargetShape = {
  messageId: messageIdSchema,
  index: z.number().int().min(0).max(63).optional(),
  sticker: z.literal(true).optional(),
  // A link preview's image, by its position in `previews`.
  preview: z.number().int().min(0).max(15).optional(),
};

export const attachmentsGetThumbnailParamsSchema = z
  .object(attachmentTargetShape)
  .strict();
export type AttachmentsGetThumbnailParamsType = z.infer<
  typeof attachmentsGetThumbnailParamsSchema
>;

export const THUMBNAIL_SIZE_PX = 640;

export type AttachmentsGetThumbnailResultType = Readonly<{
  contentType: 'image/webp' | 'image/png';
  width: number;
  height: number;
  data: string;
}>;

// Base64 grows content by a third; this keeps a chunk well inside a frame.
export const MAX_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export const attachmentsReadParamsSchema = z
  .object({
    ...attachmentTargetShape,
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(MAX_ATTACHMENT_CHUNK_BYTES),
  })
  .strict();
export type AttachmentsReadParamsType = z.infer<
  typeof attachmentsReadParamsSchema
>;

export type AttachmentsReadResultType = Readonly<{
  contentType: string;
  // Total size of the decrypted content.
  size: number;
  offset: number;
  // Base64; shorter than asked for at the end.
  data: string;
}>;

export const attachmentsDownloadParamsSchema = z
  .object({ messageId: messageIdSchema })
  .strict();
export type AttachmentsDownloadParamsType = z.infer<
  typeof attachmentsDownloadParamsSchema
>;

// Fork additions: edit and delete, as Signal's message menu does them.
export const messagesEditParamsSchema = z
  .object({
    messageId: messageIdSchema,
    body: z.string().min(1).max(MAX_SEND_BODY_LENGTH),
  })
  .strict();
export type MessagesEditParamsType = z.infer<typeof messagesEditParamsSchema>;

export const messagesDeleteParamsSchema = z
  .object({
    messageId: messageIdSchema,
    // False deletes from this device and the user's linked devices only.
    forEveryone: z.boolean(),
  })
  .strict();
export type MessagesDeleteParamsType = z.infer<
  typeof messagesDeleteParamsSchema
>;

// Fork addition: uploads for sending. The client announces a file, sends
// its content in order in chunks, then names the upload in
// messages.sendText. Signal processes it as its composer does (images
// re-encoded without metadata, size limits by type). Unsent uploads expire.
export const attachmentsUploadBeginParamsSchema = z
  .object({
    contentType: z.string().min(1).max(255),
    fileName: z.string().min(1).max(255).optional(),
    size: z.number().int().min(1),
  })
  .strict();
export type AttachmentsUploadBeginParamsType = z.infer<
  typeof attachmentsUploadBeginParamsSchema
>;

export type AttachmentsUploadBeginResultType = Readonly<{
  uploadId: string;
}>;

export const attachmentsUploadChunkParamsSchema = z
  .object({
    uploadId: z.string().uuid(),
    // Must equal the bytes received so far.
    offset: z.number().int().min(0),
    // Base64, at most MAX_ATTACHMENT_CHUNK_BYTES decoded.
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES / 3) * 4),
  })
  .strict();
export type AttachmentsUploadChunkParamsType = z.infer<
  typeof attachmentsUploadChunkParamsSchema
>;

export type AttachmentsUploadChunkResultType = Readonly<{
  received: number;
  complete: boolean;
}>;

// Fork addition: forward a message, as Signal's Forward does, to any number
// of chats (Signal's dialog stops at five; Mike asked for no limit). Each
// chat is refused on its own for the same reasons sending would be.
export const MAX_FORWARD_CONVERSATIONS = 5000;

export const messagesForwardParamsSchema = z
  .object({
    messageId: messageIdSchema,
    conversationIds: z
      .array(conversationIdSchema)
      .min(1)
      .max(MAX_FORWARD_CONVERSATIONS),
  })
  .strict();
export type MessagesForwardParamsType = z.infer<
  typeof messagesForwardParamsSchema
>;

export type ForwardResultDTO = Readonly<{
  conversationId: string;
  ok: boolean;
  reason: SendBlockReasonType | 'notFound' | null;
}>;

export type MessagesForwardResultType = Readonly<{
  results: ReadonlyArray<ForwardResultDTO>;
}>;

export const notificationsSetHandledParamsSchema = z
  .object({
    handled: z.boolean(),
  })
  .strict();

// Why Signal refused to send. Signal never asks the user on the app's behalf
// (no safety-number prompt, no implicit message-request acceptance); the user
// resolves these in Signal itself.
export const SendBlockReason = {
  Expired: 'expired',
  InvalidConversation: 'invalidConversation',
  Blocked: 'blocked',
  LeftGroup: 'leftGroup',
  MessageRequest: 'messageRequest',
  Unregistered: 'unregistered',
  ProfileSharingRequired: 'profileSharingRequired',
  PendingApproval: 'pendingApproval',
  AnnouncementOnly: 'announcementOnly',
  Terminated: 'terminated',
  UntrustedIdentity: 'untrustedIdentity',
  TooLong: 'tooLong',
  // Fork additions.
  AttachmentTooLarge: 'attachmentTooLarge',
  NotForwardable: 'notForwardable',
  NotDownloaded: 'notDownloaded',
} as const;
export type SendBlockReasonType =
  (typeof SendBlockReason)[keyof typeof SendBlockReason];

export const SERVICE_PARAM_SCHEMAS = {
  [Method.ConversationsList]: conversationsListParamsSchema,
  [Method.ConversationsGet]: conversationsGetParamsSchema,
  [Method.MessagesList]: messagesListParamsSchema,
  [Method.MessagesGet]: messagesGetParamsSchema,
  [Method.MessagesSendText]: messagesSendTextParamsSchema,
  [Method.MessagesMarkRead]: messagesMarkReadParamsSchema,
  [Method.ConversationsGetAvatar]: conversationsGetAvatarParamsSchema,
  [Method.MessagesReact]: messagesReactParamsSchema,
  [Method.ReactionsGetPreferred]: reactionsGetPreferredParamsSchema,
  [Method.AttachmentsGetThumbnail]: attachmentsGetThumbnailParamsSchema,
  [Method.AttachmentsRead]: attachmentsReadParamsSchema,
  [Method.AttachmentsDownload]: attachmentsDownloadParamsSchema,
  [Method.MessagesEdit]: messagesEditParamsSchema,
  [Method.MessagesDelete]: messagesDeleteParamsSchema,
  [Method.AttachmentsUploadBegin]: attachmentsUploadBeginParamsSchema,
  [Method.AttachmentsUploadChunk]: attachmentsUploadChunkParamsSchema,
  [Method.MessagesForward]: messagesForwardParamsSchema,
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
  // Signal's avatar color (A100...A210), used for initials when there is no
  // photo.
  avatarColor: string | null;
  // Changes whenever the photo does; null when there is none. Fetch the
  // photo with conversations.getAvatar.
  avatarVersion: string | null;
  // Fork addition: the chat list's preview line.
  lastMessage: LastMessageDTO | null;
  // Fork addition: position among pinned chats (0 first), as Signal orders
  // them; null when not pinned.
  pinnedIndex: number | null;
}>;

export type LastMessageDTO = Readonly<{
  // With mentions written out as @Name. Null for a deleted message.
  text: string | null;
  // Groups: who wrote it ("You" for the user), as Signal shows it.
  author: string | null;
  deleted: boolean;
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
  // Fork addition: the name Signal shows for the mention (without "@").
  title: string | null;
}>;

// Fork addition: text styles, over `body` offsets.
export type FormattingDTO = Readonly<{
  start: number;
  length: number;
  style: 'bold' | 'italic' | 'strikethrough' | 'monospace' | 'spoiler';
}>;

// Fork addition. Fetch the image with attachments.getThumbnail and
// `preview`.
export type LinkPreviewDTO = Readonly<{
  url: string;
  title: string | null;
  description: string | null;
  domain: string | null;
  hasImage: boolean;
}>;

// Metadata only. Attachment content and storage paths never cross the bridge
// through this type.
export type AttachmentMetadataDTO = Readonly<{
  contentType: string;
  size: number;
  fileName: string | null;
  width: number | null;
  height: number | null;
  // Fork additions. `ready`: attachments.read works; `notDownloaded`: ask
  // with attachments.download.
  state: 'ready' | 'downloading' | 'notDownloaded' | 'failed';
  // attachments.getThumbnail can return a preview image now.
  hasThumbnail: boolean;
  isVoiceMessage: boolean;
  isGif: boolean;
  caption: string | null;
  blurHash: string | null;
}>;

// Fork addition.
export type StickerDTO = Readonly<{
  emoji: string | null;
  width: number | null;
  height: number | null;
  // attachments.read with `sticker: true` works.
  ready: boolean;
}>;

// Who wrote a message, as Signal shows it in that conversation.
export type MemberLabelDTO = Readonly<{
  text: string;
  emoji: string | null;
}>;

export type AuthorDTO = Readonly<{
  title: string;
  avatarColor: string | null;
  // As in ConversationDTO; pass authorConversationId to
  // conversations.getAvatar.
  avatarVersion: string | null;
  // Groups only: Signal's color for this member's name ('000'...'350').
  nameColor: string | null;
  // Groups only: the label this member set for themselves in the group.
  label: MemberLabelDTO | null;
}>;

export type QuoteDTO = Readonly<{
  authorConversationId: string | null;
  author: AuthorDTO | null;
  sentAt: number | null;
  text: string | null;
}>;

export type ReactionDTO = Readonly<{
  emoji: string;
  authorConversationId: string;
  fromMe: boolean;
}>;

// Outgoing messages only. `paused` means Signal needs the user to complete a
// challenge in Signal before it can send; `partiallySent` means some
// recipients failed.
export const MessageSendStatus = {
  Sending: 'sending',
  Paused: 'paused',
  Failed: 'failed',
  PartiallySent: 'partiallySent',
  Sent: 'sent',
  Delivered: 'delivered',
  Read: 'read',
  Viewed: 'viewed',
} as const;
export type MessageSendStatusType =
  (typeof MessageSendStatus)[keyof typeof MessageSendStatus];

// Public message DTO. Never add service ids, e164s, keys, attachment paths,
// or raw protobufs here.
export type MessageDTO = Readonly<{
  id: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  kind: MessageKindType;
  authorConversationId: string | null;
  author: AuthorDTO | null;
  sentAt: number;
  receivedAt: number | null;
  body: string | null;
  // True when `body` is the first part of a long message.
  bodyTruncated: boolean;
  mentions: ReadonlyArray<MentionDTO>;
  attachments: ReadonlyArray<AttachmentMetadataDTO>;
  sticker: StickerDTO | null;
  // Fork additions.
  formatting: ReadonlyArray<FormattingDTO>;
  previews: ReadonlyArray<LinkPreviewDTO>;
  canEdit: boolean;
  canDeleteForEveryone: boolean;
  quote: QuoteDTO | null;
  edited: boolean;
  // Disappearing messages: clients must discard the message by this time.
  expiresAt: number | null;
  // Incoming only; null for outgoing.
  read: boolean | null;
  // Outgoing only; null for incoming.
  sendStatus: MessageSendStatusType | null;
  // One entry per person who reacted, oldest first.
  reactions: ReadonlyArray<ReactionDTO>;
}>;

export type MessagesListResultType = Readonly<{
  // Oldest first.
  messages: ReadonlyArray<MessageDTO>;
  nextCursor: string | null;
}>;

export type ErrorType = Readonly<{
  code: ErrorCodeType;
  message: string;
  // Only on PRECONDITION_FAILED from messages.sendText.
  reason?: SendBlockReasonType;
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
  message: string,
  reason?: SendBlockReasonType
): ResponseType {
  return {
    id,
    error: reason === undefined ? { code, message } : { code, message, reason },
  };
}
