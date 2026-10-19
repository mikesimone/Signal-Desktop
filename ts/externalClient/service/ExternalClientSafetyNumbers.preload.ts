// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../../logging/log.std.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import {
  getAllServiceIds,
  getUntrustedRecipients,
} from '../../util/blockSendUntilConversationsAreVerified.dom.ts';
import { getRecipientsByConversation } from '../../util/getRecipientsByConversation.dom.ts';
import { isNotNil } from '../../util/isNotNil.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  SafetyNumbersAcceptParamsType,
  SafetyNumbersChangedParamsType,
  SafetyNumbersChangedResultType,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import { getListedConversation } from './serviceHelpers.preload.ts';

// Fork addition (decision F35): Signal's "Safety number changed" dialog.
// Sends still refuse with UNTRUSTED_IDENTITY (decision D11); the client
// shows who changed and, only if the user picks "Send anyway", accepts
// them here the way the dialog does (verifyConversationsStoppingSend).

const log = createLogger('ExternalClientSafetyNumbers');

// The people whose new safety number stops a send to this chat, found as
// the composer finds them.
async function untrustedContacts(
  model: ConversationModel
): Promise<Array<ConversationModel>> {
  const untrusted = await getUntrustedRecipients(
    getRecipientsByConversation([model.attributes])
  );
  return [...getAllServiceIds(untrusted)]
    .map(serviceId => window.ConversationController.get(serviceId))
    .filter(isNotNil);
}

export async function listChangedSafetyNumbers({
  conversationId,
}: SafetyNumbersChangedParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const value: SafetyNumbersChangedResultType = {
    contacts: (await untrustedContacts(model)).map(contact => ({
      conversationId: contact.id,
      title: contact.getTitle(),
    })),
  };
  return { ok: true, value };
}

export async function acceptSafetyNumbers({
  conversationId,
  contactIds,
}: SafetyNumbersAcceptParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  // Only people whose change stops this chat's sends right now.
  const chosen = new Set(contactIds);
  const accepting = (await untrustedContacts(model)).filter(contact =>
    chosen.has(contact.id)
  );
  log.info(
    `acceptSafetyNumbers: accepting ${accepting.length} in ${model.idForLogging()}`
  );
  await Promise.all(
    accepting.flatMap(contact => [
      ...(contact.isUnverified() ? [contact.setVerifiedDefault()] : []),
      contact.setApproved(),
    ])
  );
  return { ok: true, value: { accepted: accepting.length } };
}
