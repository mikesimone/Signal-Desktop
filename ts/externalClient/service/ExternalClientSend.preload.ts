// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import type { MessageAttributesType } from '../../model-types.d.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import { isMissingRequiredProfileSharing } from '../../state/selectors/conversations.dom.ts';
import { ToastType } from '../../types/Toast.dom.tsx';
import {
  getAllServiceIds,
  getUntrustedRecipients,
} from '../../util/blockSendUntilConversationsAreVerified.dom.ts';
import { getRecipientsByConversation } from '../../util/getRecipientsByConversation.dom.ts';
import { isConversationSMSOnly } from '../../util/isConversationSMSOnly.std.ts';
import { isConversationEverUnregistered } from '../../util/isConversationUnregistered.dom.ts';
import { isSignalConversation } from '../../util/isSignalConversation.dom.ts';
import { shouldShowInvalidMessageToast } from '../../util/shouldShowInvalidMessageToast.preload.ts';
import { makeQuote } from '../../util/makeQuote.preload.ts';
import { isDirectConversation } from '../../util/whatTypeOfConversation.dom.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import type {
  MessagesMarkReadParamsType,
  MessagesSendTextParamsType,
  MessagesSendTextResultType,
  SendBlockReasonType,
} from '../protocol.std.ts';
import { ErrorCode, SendBlockReason } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
  loadMessage,
} from './serviceHelpers.preload.ts';
import {
  areUploadsComplete,
  shouldSendHighQualityImages,
  takeUploads,
} from './ExternalClientOutgoing.preload.ts';

// Sending and marking read for external clients. Sends take Signal's own
// path (enqueueMessageForSend), but where the composer would show a modal or
// hide itself, this refuses with a reason instead: it never asks the user
// anything on the client's behalf (decision D11).

const log = createLogger('ExternalClientSend');

function reasonForToast(toastType: ToastType): SendBlockReasonType {
  switch (toastType) {
    case ToastType.Expired:
    case ToastType.UnsupportedOS:
      return SendBlockReason.Expired;
    case ToastType.Blocked:
    case ToastType.BlockedGroup:
      return SendBlockReason.Blocked;
    case ToastType.LeftGroup:
      return SendBlockReason.LeftGroup;
    case ToastType.MessageBodyTooLong:
      return SendBlockReason.TooLong;
    default:
      return SendBlockReason.InvalidConversation;
  }
}

// The same conditions under which Signal's composer refuses to send or is
// replaced by another panel (CompositionArea), in the same order.
export async function getSendBlockReason(
  model: ConversationModel,
  body: string
): Promise<SendBlockReasonType | undefined> {
  const toast = shouldShowInvalidMessageToast(model.attributes, body);
  if (toast) {
    return reasonForToast(toast.toastType);
  }

  const conversation = model.format();
  if (isSignalConversation(model.attributes)) {
    return SendBlockReason.InvalidConversation;
  }
  if (conversation.terminated) {
    return SendBlockReason.Terminated;
  }
  if (conversation.isBlocked) {
    return SendBlockReason.Blocked;
  }
  if (
    conversation.areWePending ||
    (!conversation.acceptedMessageRequest &&
      conversation.removalStage !== 'justNotification')
  ) {
    return SendBlockReason.MessageRequest;
  }
  if (
    isDirectConversation(conversation) &&
    (isConversationSMSOnly(conversation) ||
      isConversationEverUnregistered(conversation))
  ) {
    return SendBlockReason.Unregistered;
  }
  if (isMissingRequiredProfileSharing(conversation)) {
    return SendBlockReason.ProfileSharingRequired;
  }
  if (model.isGroupV1AndDisabled()) {
    return SendBlockReason.InvalidConversation;
  }
  if (conversation.areWePendingApproval) {
    return SendBlockReason.PendingApproval;
  }
  if (conversation.announcementsOnly && !conversation.areWeAdmin) {
    return SendBlockReason.AnnouncementOnly;
  }

  // Where the composer would open the safety-number dialog.
  const untrusted = await getUntrustedRecipients(
    getRecipientsByConversation([model.attributes])
  );
  if (getAllServiceIds(untrusted).size > 0) {
    return SendBlockReason.UntrustedIdentity;
  }

  return undefined;
}

export async function sendText({
  conversationId,
  body,
  quoteMessageId,
  attachmentUploadIds,
}: MessagesSendTextParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }

  // Fork addition: replies. The quoted message must be one the client could
  // read in this conversation, as the timeline's Reply would offer it.
  let quoted: MessageAttributesType | undefined;
  if (quoteMessageId !== undefined) {
    quoted = await loadMessage(quoteMessageId);
    const quotedDto = quoted ? toMessageDTO(quoted, getDtoContext()) : null;
    if (
      !quoted ||
      quoted.conversationId !== conversationId ||
      !quotedDto ||
      quotedDto.kind === 'deleted' ||
      quotedDto.kind === 'unsupported'
    ) {
      return { ok: false, code: ErrorCode.InvalidArgument };
    }
  }

  // Fork addition: attachments, from finished uploads.
  if (attachmentUploadIds && !areUploadsComplete(attachmentUploadIds)) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }

  const reason = await getSendBlockReason(model, body);
  if (reason) {
    log.info(`sendText: refused (${reason})`);
    return { ok: false, code: ErrorCode.PreconditionFailed, reason };
  }

  const prepared = attachmentUploadIds
    ? await takeUploads(attachmentUploadIds)
    : undefined;
  if (attachmentUploadIds && !prepared) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }

  let sent: MessageAttributesType | undefined;
  try {
    sent = await model.enqueueMessageForSend(
      {
        body,
        attachments: prepared?.attachments ?? [],
        quote: quoted ? await makeQuote(quoted) : undefined,
      },
      {
        // The user may have a draft in Signal; leave it alone.
        dontClearDraft: true,
        ...(prepared ? { sendHQImages: shouldSendHighQualityImages() } : {}),
      }
    );
  } finally {
    prepared?.cleanup();
  }
  if (!sent) {
    return {
      ok: false,
      code: ErrorCode.PreconditionFailed,
      reason: SendBlockReason.InvalidConversation,
    };
  }

  const message = toMessageDTO(sent, getDtoContext());
  if (!message) {
    return { ok: false, code: ErrorCode.InternalError };
  }
  const value: MessagesSendTextResultType = { message };
  return { ok: true, value };
}

export async function markRead({
  conversationId,
  upToMessageId,
}: MessagesMarkReadParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const message = await loadMessage(upToMessageId);
  if (!message || message.conversationId !== conversationId) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }

  // The model-level call, not the Redux thunk, which does nothing unless
  // Signal's own window is active (decision D9). Receipts follow the user's
  // read-receipt setting as usual.
  await model.markRead(
    { received_at: message.received_at, sent_at: message.sent_at },
    { sendReadReceipts: true }
  );
  return { ok: true, value: {} };
}
