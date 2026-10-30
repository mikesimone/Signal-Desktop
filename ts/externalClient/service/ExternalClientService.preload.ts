// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer as ipc } from 'electron';

import { createLogger } from '../../logging/log.std.ts';
import type { MessageAttributesType } from '../../model-types.std.ts';
import { DataReader } from '../../sql/Client.preload.ts';
import * as RemoteConfig from '../../RemoteConfig.dom.ts';
import { _getConversationComparator } from '../../state/selectors/conversations.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import { drop } from '../../util/drop.std.ts';
import { safeParseUnknown } from '../../util/schemas.std.ts';
import { isGroup } from '../../util/whatTypeOfConversation.dom.ts';
import {
  isListedConversation,
  toConversationDTO,
} from '../conversationDto.std.ts';
import {
  deleteMessage,
  downloadAttachments,
  editMessage,
  getAttachmentThumbnail,
  getAvatar,
  getEmojiCatalog,
  getPreferredReactions,
  markEmojiUsed,
  react,
  readAttachment,
} from './ExternalClientExtras.preload.ts';
import {
  appendUpload,
  beginUpload,
  endPoll,
  forwardMessage,
  sendPoll,
  votePoll,
} from './ExternalClientOutgoing.preload.ts';
import { updateConversation } from './ExternalClientChats.preload.ts';
import { getDetails } from './ExternalClientDetails.preload.ts';
import { updateGroup } from './ExternalClientGroups.preload.ts';
import { locateQuote } from './ExternalClientQuotes.preload.ts';
import { fetchLinkPreview } from './ExternalClientLinkPreviews.preload.ts';
import { listMedia } from './ExternalClientMedia.preload.ts';
import { searchMessages } from './ExternalClientSearch.preload.ts';
import { listChatFolders } from './ExternalClientChatFolders.preload.ts';
import { syncContacts } from './ExternalClientContactSync.preload.ts';
import {
  acceptSafetyNumbers,
  listChangedSafetyNumbers,
} from './ExternalClientSafetyNumbers.preload.ts';
import {
  createGroup,
  findConversation,
  listContacts,
  openConversation,
} from './ExternalClientCompose.preload.ts';
import { getMembers } from './ExternalClientMentions.preload.ts';
import {
  getProfile,
  setProfile,
  setProfileAvatar,
} from './ExternalClientProfile.preload.ts';
import {
  getSettings,
  setSetting,
} from './ExternalClientPreferences.preload.ts';
import {
  getStickerImage,
  getStickerPacks,
  sendSticker,
} from './ExternalClientStickers.preload.ts';
import { markRead, sendText, setTyping } from './ExternalClientSend.preload.ts';
import {
  getDtoContext,
  getListedConversation,
  loadMessage,
  preferCached,
} from './serviceHelpers.preload.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toEditHistoryDTO, toMessageDTO } from '../messageDto.std.ts';
import type {
  ConversationsGetParamsType,
  ConversationsListParamsType,
  ConversationsListResultType,
  MessageDTO,
  MessagesGetEditHistoryParamsType,
  MessagesGetEditHistoryResultType,
  MessagesGetParamsType,
  MessagesListParamsType,
  MessagesListResultType,
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
  REFRESH_CHANNEL,
  RESULT_CHANNEL,
  rendererCallSchema,
} from '../rendererChannel.std.ts';

// Renderer half of the external-client bridge. Answers calls from the main
// process by reading Signal's own models and returning public DTOs. It holds
// no authorization logic: main has already authenticated the client and
// checked its capabilities before a call arrives here.

const log = createLogger('ExternalClientService');

function getPinnedIds(): ReadonlyArray<string> {
  return window.reduxStore.getState().items.pinnedConversationIds ?? [];
}

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
    conversations: listed
      .slice(offset, end)
      .map(conversation => toConversationDTO(conversation, getPinnedIds())),
    nextCursor: end < listed.length ? String(end) : null,
  };
  return { ok: true, value };
}

function getConversation({
  conversationId,
}: ConversationsGetParamsType): ServiceResultType {
  if (!window.ConversationController.isInitialFetchComplete()) {
    return notReady;
  }
  const model = getListedConversation(conversationId);
  if (!model) {
    return notFound;
  }
  return {
    ok: true,
    value: { conversation: toConversationDTO(model.format(), getPinnedIds()) },
  };
}

async function listMessages({
  conversationId,
  limit = LIMITS.defaultMessagePage,
  cursor,
  newer = false,
}: MessagesListParamsType): Promise<ServiceResultType> {
  if (!window.ConversationController.isInitialFetchComplete()) {
    return notReady;
  }
  const model = getListedConversation(conversationId);
  if (!model) {
    return notFound;
  }

  let anchor: MessageAttributesType | undefined;
  if (cursor !== undefined) {
    anchor = await loadMessage(cursor);
    if (!anchor || anchor.conversationId !== conversationId) {
      return { ok: false, code: ErrorCode.InvalidArgument };
    }
  }

  // Same queries the timeline uses to load older and newer messages.
  // Results are oldest first.
  const query = {
    conversationId,
    includeStoryReplies: !isGroup(model.attributes),
    limit,
    messageId: anchor?.id,
    receivedAt: anchor?.received_at,
    sentAt: anchor?.sent_at,
    storyId: undefined,
  };
  const page = newer
    ? await DataReader.getNewerMessagesByConversation(query)
    : await DataReader.getOlderMessagesByConversation(query);

  const context = getDtoContext();
  const messages = new Array<MessageDTO>();
  for (const message of page) {
    const dto = toMessageDTO(preferCached(message), context);
    if (dto) {
      messages.push(dto);
    }
  }

  // The cursor is the last row read (the oldest, or the newest when paging
  // forward), even if it was filtered out, so the next page continues where
  // this one stopped.
  const last = newer ? page.at(-1) : page.at(0);
  const value: MessagesListResultType = {
    messages,
    nextCursor: page.length === limit && last ? last.id : null,
  };
  return { ok: true, value };
}

async function getMessage({
  messageId,
}: MessagesGetParamsType): Promise<ServiceResultType> {
  if (!window.ConversationController.isInitialFetchComplete()) {
    return notReady;
  }
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return notFound;
  }
  const dto = toMessageDTO(message, getDtoContext());
  if (!dto) {
    return notFound;
  }
  return { ok: true, value: { message: dto } };
}

// Fork addition (decision F39).
async function getEditHistory({
  messageId,
}: MessagesGetEditHistoryParamsType): Promise<ServiceResultType> {
  if (!window.ConversationController.isInitialFetchComplete()) {
    return notReady;
  }
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return notFound;
  }
  const value: MessagesGetEditHistoryResultType = {
    versions: toEditHistoryDTO(message, getDtoContext()),
  };
  return { ok: true, value };
}

async function dispatch(
  method: ServiceMethodType,
  rawParams: unknown
): Promise<ServiceResultType> {
  const invalid: ServiceResultType = {
    ok: false,
    code: ErrorCode.InvalidArgument,
  };
  // Main validated these already; validate again rather than trust IPC.
  switch (method) {
    case Method.ConversationsList: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listConversations(params.data) : invalid;
    }
    case Method.ConversationsGet: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getConversation(params.data) : invalid;
    }
    case Method.MessagesList: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listMessages(params.data) : invalid;
    }
    case Method.MessagesGet: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getMessage(params.data) : invalid;
    }
    case Method.MessagesGetEditHistory: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getEditHistory(params.data) : invalid;
    }
    case Method.MessagesSendText: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? sendText(params.data) : invalid;
    }
    case Method.MessagesMarkRead: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? markRead(params.data) : invalid;
    }
    case Method.ConversationsGetMembers: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getMembers(params.data) : invalid;
    }
    case Method.ConversationsGetAvatar: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getAvatar(params.data) : invalid;
    }
    case Method.MessagesReact: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? react(params.data) : invalid;
    }
    case Method.EmojiGetCatalog: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getEmojiCatalog() : invalid;
    }
    case Method.EmojiMarkUsed: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? markEmojiUsed(params.data) : invalid;
    }
    case Method.ReactionsGetPreferred: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getPreferredReactions() : invalid;
    }
    case Method.AttachmentsGetThumbnail: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getAttachmentThumbnail(params.data) : invalid;
    }
    case Method.AttachmentsRead: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? readAttachment(params.data) : invalid;
    }
    case Method.AttachmentsDownload: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? downloadAttachments(params.data) : invalid;
    }
    case Method.MessagesEdit: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? editMessage(params.data) : invalid;
    }
    case Method.MessagesDelete: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? deleteMessage(params.data) : invalid;
    }
    case Method.AttachmentsUploadBegin: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? beginUpload(params.data) : invalid;
    }
    case Method.AttachmentsUploadChunk: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? appendUpload(params.data) : invalid;
    }
    case Method.MessagesForward: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? forwardMessage(params.data) : invalid;
    }
    case Method.PollsVote: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? votePoll(params.data) : invalid;
    }
    case Method.PollsEnd: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? endPoll(params.data) : invalid;
    }
    case Method.PollsSend: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? sendPoll(params.data) : invalid;
    }
    case Method.StickersGetPacks: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getStickerPacks() : invalid;
    }
    case Method.StickersGetImage: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getStickerImage(params.data) : invalid;
    }
    case Method.SettingsGet: {
      // The blocked list needs Signal's conversations.
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getSettings() : invalid;
    }
    case Method.SettingsSet: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? setSetting(params.data) : invalid;
    }
    case Method.MessagesSendSticker: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? sendSticker(params.data) : invalid;
    }
    case Method.ConversationsSetTyping: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? setTyping(params.data) : invalid;
    }
    case Method.ConversationsGetDetails: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getDetails(params.data) : invalid;
    }
    case Method.ContactsList: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listContacts(params.data) : invalid;
    }
    case Method.ConversationsFind: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? findConversation(params.data) : invalid;
    }
    case Method.ConversationsOpen: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? openConversation(params.data) : invalid;
    }
    case Method.GroupsCreate: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? createGroup(params.data) : invalid;
    }
    case Method.MessagesLocateQuote: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? locateQuote(params.data) : invalid;
    }
    case Method.SafetyNumbersChanged: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listChangedSafetyNumbers(params.data) : invalid;
    }
    case Method.SafetyNumbersAccept: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? acceptSafetyNumbers(params.data) : invalid;
    }
    case Method.ContactsSync: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? syncContacts() : invalid;
    }
    case Method.ChatFoldersList: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listChatFolders() : invalid;
    }
    case Method.MediaList: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? listMedia(params.data) : invalid;
    }
    case Method.LinkPreviewsFetch: {
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? fetchLinkPreview(params.data) : invalid;
    }
    case Method.GroupsUpdate: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? updateGroup(params.data) : invalid;
    }
    case Method.MessagesSearch: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? searchMessages(params.data) : invalid;
    }
    case Method.ConversationsUpdate: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? updateConversation(params.data) : invalid;
    }
    case Method.ProfileGet: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? getProfile() : invalid;
    }
    case Method.ProfileSet: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? setProfile(params.data) : invalid;
    }
    case Method.ProfileSetAvatar: {
      if (!window.ConversationController.isInitialFetchComplete()) {
        return notReady;
      }
      const params = safeParseUnknown(SERVICE_PARAM_SCHEMAS[method], rawParams);
      return params.success ? setProfileAvatar(params.data) : invalid;
    }
    default:
      throw new Error(`Unhandled external client method ${method}`);
  }
}

async function answer(
  seq: number,
  method: ServiceMethodType,
  params: unknown
): Promise<void> {
  let result: ServiceResultType;
  try {
    result = await dispatch(method, params);
  } catch (error) {
    log.error(`${method} failed`, Errors.toLogFormat(error));
    result = { ok: false, code: ErrorCode.InternalError };
  }
  ipc.send(RESULT_CHANNEL, { seq, ...result } satisfies RendererResultType);
}

export function installExternalClientService(): void {
  // Main decides whether the bridge runs; it only needs to know when
  // Signal's flag for it changes.
  RemoteConfig.onChange(
    ['desktop.externalClients.beta', 'desktop.externalClients.prod'],
    () => ipc.send(REFRESH_CHANNEL)
  );

  ipc.on(CALL_CHANNEL, (_event, message: unknown) => {
    const call = safeParseUnknown(rendererCallSchema, message);
    if (!call.success) {
      log.warn('dropping malformed call');
      return;
    }

    const { seq, method, params } = call.data;
    drop(answer(seq, method, params));
  });
}
