// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type {
  BroadcastEventNameType,
  ErrorCodeType,
  EventTopicType,
  ServiceMethodType,
} from './protocol.std.ts';
import {
  ALL_EVENT_TOPICS,
  ErrorCode,
  EVENT_TOPICS,
  SERVICE_METHOD_CAPABILITIES,
} from './protocol.std.ts';

// The only IPC between the main-process bridge and the renderer service.
// Main sends a validated call for a method on a closed list; the renderer
// answers with a DTO or an error code. Client JSON is never forwarded.
//
// For live updates, main tells the renderer which topics any client is
// subscribed to, and the renderer sends batches of events (already DTOs)
// for those topics only. With no subscribers the renderer does no work.

export const CALL_CHANNEL = 'external-client:call';
export const RESULT_CHANNEL = 'external-client:result';
// renderer -> main, no payload: the renderer (re)started and wants topics.
export const EVENTS_READY_CHANNEL = 'external-client:events-ready';
// main -> renderer: RendererTopicsType
export const TOPICS_CHANNEL = 'external-client:topics';
// renderer -> main: RendererEventsType
export const EVENTS_CHANNEL = 'external-client:events';

export const MAX_EVENTS_PER_BATCH = 200;

const eventTopicEnum = z.enum(
  ALL_EVENT_TOPICS as [EventTopicType, ...Array<EventTopicType>]
);

export const rendererTopicsSchema = z
  .object({
    topics: z.array(eventTopicEnum).max(ALL_EVENT_TOPICS.length),
  })
  .strict();
export type RendererTopicsType = z.infer<typeof rendererTopicsSchema>;

const broadcastEvents = Object.keys(EVENT_TOPICS) as [
  BroadcastEventNameType,
  ...Array<BroadcastEventNameType>,
];

export const rendererEventsSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            event: z.enum(broadcastEvents),
            data: z.record(z.string(), z.unknown()),
          })
          .strict()
      )
      .max(MAX_EVENTS_PER_BATCH),
    // The renderer fell too far behind and discarded queued events. Every
    // subscribed client gets `events.dropped` and must resynchronize.
    overflow: z.boolean().optional(),
  })
  .strict();
export type RendererEventsType = z.infer<typeof rendererEventsSchema>;

const serviceMethods = Object.keys(SERVICE_METHOD_CAPABILITIES) as [
  ServiceMethodType,
  ...Array<ServiceMethodType>,
];

export const rendererCallSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    method: z.enum(serviceMethods),
    params: z.unknown(),
  })
  .strict();
export type RendererCallType = z.infer<typeof rendererCallSchema>;

const errorCodes = Object.values(ErrorCode) as [
  ErrorCodeType,
  ...Array<ErrorCodeType>,
];

export const rendererResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      seq: z.number().int().nonnegative(),
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().nonnegative(),
      ok: z.literal(false),
      code: z.enum(errorCodes),
    })
    .strict(),
]);
export type RendererResultType = z.infer<typeof rendererResultSchema>;
