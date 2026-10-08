// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { ErrorCodeType, ServiceMethodType } from './protocol.std.ts';
import { ErrorCode, SERVICE_METHOD_CAPABILITIES } from './protocol.std.ts';

// The only IPC between the main-process bridge and the renderer service.
// Main sends a validated call for a method on a closed list; the renderer
// answers with a DTO or an error code. Client JSON is never forwarded.

export const CALL_CHANNEL = 'external-client:call';
export const RESULT_CHANNEL = 'external-client:result';

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
