// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { v4 as generateUuid } from 'uuid';

import { createLogger } from '../../logging/log.std.ts';
import { getMessageById } from '../../messages/getMessageById.preload.ts';
import { enqueuePollTerminateForSend } from '../../polls/enqueuePollTerminateForSend.preload.ts';
import { enqueuePollVoteForSend } from '../../polls/enqueuePollVoteForSend.preload.ts';
import { getValue as getRemoteConfigValue } from '../../RemoteConfig.dom.ts';
import { getConversationSelector } from '../../state/selectors/conversations.dom.ts';
import { getHasMediaBackups } from '../../state/selectors/items.dom.ts';
import {
  canForward,
  getMessagePropsSelector,
} from '../../state/selectors/message.preload.ts';
import type { MessageAttributesType } from '../../model-types.d.ts';
import type { AttachmentType } from '../../types/Attachment.std.ts';
import {
  getAttachmentSizeLimit,
  isAttachmentTooLargeToSend,
} from '../../types/AttachmentSize.std.ts';
import * as Errors from '../../types/errors.std.ts';
import { isDraftForwardable } from '../../types/ForwardDraft.std.ts';
import type {
  ForwardMessageData,
  MessageForwardDraft,
} from '../../types/ForwardDraft.std.ts';
import { stringToMIMEType } from '../../types/MIME.std.ts';
import { isPollSend1to1Enabled } from '../../types/Polls.dom.ts';
import { hydrateRanges } from '../../util/BodyRange.node.ts';
import { deleteDraftAttachment } from '../../util/deleteDraftAttachment.preload.ts';
import { isDownloadableOrBackfillable } from '../../util/downloadAttachment.preload.ts';
import { drop } from '../../util/drop.std.ts';
import { enqueuePollCreateForSend } from '../../util/enqueuePollCreateForSend.dom.ts';
import { maybeForwardMessages } from '../../util/maybeForwardMessages.preload.ts';
import { isDirectConversation } from '../../util/whatTypeOfConversation.dom.ts';
import { processAttachment } from '../../util/processAttachment.preload.ts';
import { resolveAttachmentDraftData } from '../../util/resolveAttachmentDraftData.preload.ts';
import { writeDraftAttachment } from '../../util/writeDraftAttachment.preload.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import type {
  AttachmentsUploadBeginParamsType,
  AttachmentsUploadBeginResultType,
  AttachmentsUploadChunkParamsType,
  AttachmentsUploadChunkResultType,
  ForwardResultDTO,
  MessagesForwardParamsType,
  MessagesForwardResultType,
  PollsEndParamsType,
  PollsSendParamsType,
  PollsSendResultType,
  PollsVoteParamsType,
  SendBlockReasonType,
} from '../protocol.std.ts';
import { ErrorCode, SendBlockReason } from '../protocol.std.ts';
import { getSendBlockReason } from './ExternalClientSend.preload.ts';
import {
  getDtoContext,
  getListedConversation,
  loadMessage,
} from './serviceHelpers.preload.ts';

// Fork-only: sending attachments and forwarding (not part of the upstream
// proposal). Uploads live in memory until sent; Signal then processes them
// exactly as its composer does.

const log = createLogger('ExternalClientOutgoing');

const UPLOAD_TTL_MS = 10 * 60 * 1000;
// All unsent uploads together, from every client.
const MAX_PENDING_UPLOAD_BYTES = 512 * 1024 * 1024;

type UploadType = {
  contentType: string;
  fileName: string | undefined;
  size: number;
  chunks: Array<Uint8Array<ArrayBuffer>>;
  received: number;
  expiresAt: number;
};

const uploads = new Map<string, UploadType>();

function pruneUploads(): void {
  const now = Date.now();
  for (const [id, upload] of uploads) {
    if (upload.expiresAt <= now) {
      uploads.delete(id);
    }
  }
}

function pendingBytes(): number {
  let total = 0;
  for (const upload of uploads.values()) {
    total += upload.size;
  }
  return total;
}

export function beginUpload({
  contentType,
  fileName,
  size,
}: AttachmentsUploadBeginParamsType): ServiceResultType {
  pruneUploads();
  const limit = getAttachmentSizeLimit({
    contentType: stringToMIMEType(contentType),
    getRemoteConfigValue,
  });
  if (isAttachmentTooLargeToSend({ plaintextSize: size, limit })) {
    return {
      ok: false,
      code: ErrorCode.PreconditionFailed,
      reason: SendBlockReason.AttachmentTooLarge,
    };
  }
  if (pendingBytes() + size > MAX_PENDING_UPLOAD_BYTES) {
    return { ok: false, code: ErrorCode.RateLimited };
  }
  const uploadId = generateUuid();
  uploads.set(uploadId, {
    contentType,
    fileName,
    size,
    chunks: [],
    received: 0,
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  });
  const value: AttachmentsUploadBeginResultType = { uploadId };
  return { ok: true, value };
}

export function appendUpload({
  uploadId,
  offset,
  data,
}: AttachmentsUploadChunkParamsType): ServiceResultType {
  pruneUploads();
  const upload = uploads.get(uploadId);
  if (!upload) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  if (offset !== upload.received || offset + bytes.length > upload.size) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  upload.chunks.push(bytes);
  upload.received += bytes.length;
  upload.expiresAt = Date.now() + UPLOAD_TTL_MS;
  const value: AttachmentsUploadChunkResultType = {
    received: upload.received,
    complete: upload.received === upload.size,
  };
  return { ok: true, value };
}

// True when every upload exists and has all of its content.
export function areUploadsComplete(uploadIds: ReadonlyArray<string>): boolean {
  pruneUploads();
  return uploadIds.every(id => {
    const upload = uploads.get(id);
    return upload !== undefined && upload.received === upload.size;
  });
}

export type PreparedAttachmentsType = Readonly<{
  attachments: Array<AttachmentType>;
  // Draft files to delete once the message has been saved.
  cleanup: () => void;
}>;

// Turns finished uploads into attachments the way the composer does:
// process (re-encode images, screenshot videos), write a draft, read it back.
export async function takeUploads(
  uploadIds: ReadonlyArray<string>
): Promise<PreparedAttachmentsType | undefined> {
  if (!areUploadsComplete(uploadIds)) {
    return undefined;
  }
  const taken = uploadIds.map(id => {
    const upload = uploads.get(id);
    uploads.delete(id);
    return upload;
  });

  const drafts: Array<AttachmentType> = [];
  const cleanup = () => {
    for (const draft of drafts) {
      drop(deleteDraftAttachment(draft));
    }
  };
  try {
    for (const upload of taken) {
      if (!upload) {
        throw new Error('upload vanished');
      }
      const file = new File(upload.chunks, upload.fileName ?? 'file', {
        type: upload.contentType,
      });
      // oxlint-disable-next-line no-await-in-loop
      const inMemory = await processAttachment(file, {
        generateScreenshot: true,
        flags: null,
      });
      if (!inMemory) {
        throw new Error('processAttachment refused the file');
      }
      // oxlint-disable-next-line no-await-in-loop
      const draft = await writeDraftAttachment(inMemory);
      // oxlint-disable-next-line no-await-in-loop
      const resolved = await resolveAttachmentDraftData(draft);
      if (!resolved) {
        drop(deleteDraftAttachment(draft));
        throw new Error('draft could not be read back');
      }
      drafts.push(resolved);
    }
  } catch (error) {
    log.warn('takeUploads failed', Errors.toLogFormat(error));
    cleanup();
    return undefined;
  }
  return { attachments: drafts, cleanup };
}

// The composer's choice between standard and high quality images.
export function shouldSendHighQualityImages(): boolean {
  return window.reduxStore.getState().items['sent-media-quality'] === 'high';
}

// Builds the same draft Signal's Forward dialog would (toMessageForwardDraft).
async function getForwardDraft(
  messageId: string
): Promise<ForwardMessageData | SendBlockReasonType | 'notFound'> {
  const message = await getMessageById(messageId);
  if (!message) {
    return 'notFound';
  }
  const { attributes } = message;
  const dto = toMessageDTO(attributes, getDtoContext());
  if (
    !dto ||
    dto.kind === 'deleted' ||
    dto.kind === 'unsupported' ||
    !canForward(attributes)
  ) {
    return SendBlockReason.NotForwardable;
  }

  const state = window.reduxStore.getState();
  const hasMediaBackups = getHasMediaBackups(state);
  const props = getMessagePropsSelector(state)(attributes);
  const draft: MessageForwardDraft = {
    attachments: (props.attachments ?? []).filter(attachment =>
      isDownloadableOrBackfillable({
        attachment,
        attachmentType: 'attachment',
        isStory: attributes.type === 'story',
        hasMediaBackups,
      })
    ),
    bodyRanges: hydrateRanges(props.bodyRanges, getConversationSelector(state)),
    hasContact: Boolean(props.contact),
    isSticker: Boolean(props.isSticker),
    messageBody: props.text,
    originalMessageId: props.id,
    previews: props.previews ?? [],
  };
  if (!isDraftForwardable(draft)) {
    // As the dialog does: start the download, and let the user retry.
    window.reduxActions.conversations.kickOffAttachmentDownload({
      messageId,
    });
    return SendBlockReason.NotDownloaded;
  }
  return { draft, originalMessage: attributes };
}

export async function forwardMessage({
  messageId,
  conversationIds,
}: MessagesForwardParamsType): Promise<ServiceResultType> {
  // Only messages the client can read in a listed conversation.
  const source = await loadMessage(messageId);
  if (!source || !getListedConversation(source.conversationId)) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const forward = await getForwardDraft(messageId);
  if (forward === 'notFound') {
    return { ok: false, code: ErrorCode.NotFound };
  }
  if (typeof forward === 'string') {
    return { ok: false, code: ErrorCode.PreconditionFailed, reason: forward };
  }

  const body = forward.draft.messageBody ?? '';
  const results: Array<ForwardResultDTO> = [];
  const allowed: Array<string> = [];
  for (const conversationId of new Set(conversationIds)) {
    const model = getListedConversation(conversationId);
    if (!model) {
      results.push({ conversationId, ok: false, reason: 'notFound' });
      continue;
    }
    // Each chat is refused on its own, for the same reasons as sending; so
    // Forward never opens the safety-number dialog (decision D11).
    // oxlint-disable-next-line no-await-in-loop
    const reason = await getSendBlockReason(model, body);
    if (reason) {
      results.push({ conversationId, ok: false, reason });
      continue;
    }
    allowed.push(conversationId);
  }

  if (allowed.length > 0) {
    const sent = await maybeForwardMessages([forward], allowed);
    for (const conversationId of allowed) {
      results.push({
        conversationId,
        ok: sent,
        reason: sent ? null : SendBlockReason.UntrustedIdentity,
      });
    }
  }
  log.info(
    `forwardMessage: ${allowed.length} of ${results.length} chats accepted`
  );
  const value: MessagesForwardResultType = { results };
  return { ok: true, value };
}

// Fork addition: polls, as the timeline's poll bubble and the composer's
// poll dialog send them.

async function loadOpenPoll(
  messageId: string
): Promise<
  | Readonly<{ ok: true; message: MessageAttributesType }>
  | Readonly<{ ok: false; result: ServiceResultType }>
> {
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return { ok: false, result: { ok: false, code: ErrorCode.NotFound } };
  }
  const dto = toMessageDTO(message, getDtoContext());
  if (!dto?.poll) {
    return {
      ok: false,
      result: { ok: false, code: ErrorCode.InvalidArgument },
    };
  }
  if (dto.poll.ended) {
    return {
      ok: false,
      result: {
        ok: false,
        code: ErrorCode.PreconditionFailed,
        reason: SendBlockReason.PollEnded,
      },
    };
  }
  return { ok: true, message };
}

export async function votePoll({
  messageId,
  optionIndexes,
}: PollsVoteParamsType): Promise<ServiceResultType> {
  const loaded = await loadOpenPoll(messageId);
  if (!loaded.ok) {
    return loaded.result;
  }
  const { message } = loaded;
  const options = message.poll?.options.length ?? 0;
  const picked = [...new Set(optionIndexes)];
  if (
    picked.some(index => index >= options) ||
    (!message.poll?.allowMultiple && picked.length > 1)
  ) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  const model = getListedConversation(message.conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const reason = await getSendBlockReason(model, '');
  if (reason) {
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }
  await enqueuePollVoteForSend({ messageId, optionIndexes: picked });
  return { ok: true, value: {} };
}

export async function endPoll({
  messageId,
}: PollsEndParamsType): Promise<ServiceResultType> {
  const loaded = await loadOpenPoll(messageId);
  if (!loaded.ok) {
    return loaded.result;
  }
  if (!toMessageDTO(loaded.message, getDtoContext())?.poll?.canEnd) {
    return { ok: false, code: ErrorCode.PreconditionFailed };
  }
  const model = getListedConversation(loaded.message.conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const reason = await getSendBlockReason(model, '');
  if (reason) {
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }
  await enqueuePollTerminateForSend({ messageId });
  return { ok: true, value: {} };
}

// Signal's poll dialog sends to one chat. Here one call can send the same
// poll to many; each chat gets its own poll with its own votes, and each is
// refused on its own as a send there would be (decision D11).
export async function sendPoll({
  conversationIds,
  question,
  options,
  allowMultiple,
}: PollsSendParamsType): Promise<ServiceResultType> {
  const results: Array<ForwardResultDTO> = [];
  for (const conversationId of new Set(conversationIds)) {
    const model = getListedConversation(conversationId);
    if (!model) {
      results.push({ conversationId, ok: false, reason: 'notFound' });
      continue;
    }
    if (isDirectConversation(model.attributes) && !isPollSend1to1Enabled()) {
      results.push({
        conversationId,
        ok: false,
        reason: SendBlockReason.PollsNotSupported,
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const reason = await getSendBlockReason(model, question);
    if (reason) {
      results.push({ conversationId, ok: false, reason });
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      await enqueuePollCreateForSend(model, {
        question,
        options,
        allowMultiple,
      });
      results.push({ conversationId, ok: true, reason: null });
    } catch (error) {
      log.warn('sendPoll failed', Errors.toLogFormat(error));
      results.push({
        conversationId,
        ok: false,
        reason: SendBlockReason.InvalidConversation,
      });
    }
  }
  log.info(
    `sendPoll: ${results.filter(result => result.ok).length} of ${results.length} chats`
  );
  const value: PollsSendResultType = { results };
  return { ok: true, value };
}
