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
} as const;
export type LimitsType = { readonly [K in keyof typeof LIMITS]: number };

// The capability vocabulary this server understands. A client must still be
// granted a capability before any method requiring it will run.
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

export const Method = {
  Hello: 'session.hello',
  Disconnect: 'session.disconnect',
} as const;
export type MethodType = (typeof Method)[keyof typeof Method];

const requestIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxRequestIdLength)
  .regex(/^[A-Za-z0-9._:-]+$/);

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
