// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer as ipc } from 'electron';

import { createLogger } from '../../logging/log.std.ts';
import { _getConversationComparator } from '../../state/selectors/conversations.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import { safeParseUnknown } from '../../util/schemas.std.ts';
import {
  isListedConversation,
  toConversationDTO,
} from '../conversationDto.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ConversationsGetParamsType,
  ConversationsListParamsType,
  ConversationsListResultType,
  ServiceMethodType,
} from '../protocol.std.ts';
import {
  ErrorCode,
  LIMITS,
  Method,
  SERVICE_PARAM_SCHEMAS,
} from '../protocol.std.ts';
import type { RendererResultType } from '../rendererChannel.std.ts';
import {
  CALL_CHANNEL,
  RESULT_CHANNEL,
  rendererCallSchema,
} from '../rendererChannel.std.ts';

// Renderer half of the external-client bridge. Answers calls from the main
// process by reading Signal's own models and returning public DTOs. It holds
// no authorization logic: main has already authenticated the client and
// checked its capabilities before a call arrives here.

const log = createLogger('ExternalClientService');

const notReady: ServiceResultType = { ok: false, code: ErrorCode.NotReady };
const notFound: ServiceResultType = { ok: false, code: ErrorCode.NotFound };

function listConversations({
  limit = LIMITS.defaultConversationPage,
  cursor,
}: ConversationsListParamsType): ServiceResultType {
  const controller = window.ConversationController;
  if (!controller.isInitialFetchComplete()) {
    return notReady;
  }

  const listed = controller
    .getAll()
    .map(model => model.format())
    .filter(isListedConversation)
    .sort(_getConversationComparator());

  const offset = cursor === undefined ? 0 : Number(cursor);
  const end = offset + limit;
  const value: ConversationsListResultType = {
    conversations: listed.slice(offset, end).map(toConversationDTO),
    nextCursor: end < listed.length ? String(end) : null,
  };
  return { ok: true, value };
}

function getConversation({
  conversationId,
}: ConversationsGetParamsType): ServiceResultType {
  const controller = window.ConversationController;
  if (!controller.isInitialFetchComplete()) {
    return notReady;
  }

  // `get` also resolves phone numbers and service ids; only accept our own
  // conversation ids so this cannot be used as a lookup oracle.
  const model = controller.get(conversationId);
  if (!model || model.id !== conversationId) {
    return notFound;
  }
  const conversation = model.format();
  if (!isListedConversation(conversation)) {
    return notFound;
  }
  return { ok: true, value: { conversation: toConversationDTO(conversation) } };
}

function dispatch(
  method: ServiceMethodType,
  rawParams: unknown
): ServiceResultType {
  // Main validated these already; validate again rather than trust IPC.
  switch (method) {
    case Method.ConversationsList: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success
        ? listConversations(params.data)
        : { ok: false, code: ErrorCode.InvalidArgument };
    }
    case Method.ConversationsGet: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success
        ? getConversation(params.data)
        : { ok: false, code: ErrorCode.InvalidArgument };
    }
    default:
      throw new Error(`Unhandled external client method ${method}`);
  }
}

export function installExternalClientService(): void {
  ipc.on(CALL_CHANNEL, (_event, message: unknown) => {
    const call = safeParseUnknown(rendererCallSchema, message);
    if (!call.success) {
      log.warn('dropping malformed call');
      return;
    }

    const { seq, method, params } = call.data;
    let result: ServiceResultType;
    try {
      result = dispatch(method, params);
    } catch (error) {
      log.error(`${method} failed`, Errors.toLogFormat(error));
      result = { ok: false, code: ErrorCode.InternalError };
    }
    ipc.send(RESULT_CHANNEL, { seq, ...result } satisfies RendererResultType);
  });
}
