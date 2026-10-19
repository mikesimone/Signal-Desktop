// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DurationMs, MuteExpiration } from '@signalapp/types';

import { createLogger } from '../../logging/log.std.ts';
import { DataWriter } from '../../sql/Client.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import { getPinnedConversationLimit } from '../../util/Conversation.preload.ts';
import { drop } from '../../util/drop.std.ts';
import { DurationInSeconds } from '../../util/durations/duration-in-seconds.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type { ConversationsUpdateParamsType } from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';

// Fork addition: Signal's chat menu actions for external clients (decision
// F15). Each dispatches the Redux action Signal's own menus dispatch
// (ConversationHeader, the chat list's context menu), so syncing to the
// phone and other devices happens exactly as there. The actions run on
// their own, as from Signal's menus; the result says the change was started,
// and conversation.updated reports it.

const log = createLogger('ExternalClientChats');

export function updateConversation({
  conversationId,
  change,
}: ConversationsUpdateParamsType): ServiceResultType {
  // Blocked chats and message requests aren't always listed, and they are
  // what block, accept and delete act on.
  const model = window.ConversationController.get(conversationId);
  if (!model || model.id !== conversationId) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const actions = window.reduxActions.conversations;
  try {
    switch (change.action) {
      case 'mute':
        actions.setMuteExpiration(
          conversationId,
          change.durationMs == null
            ? MuteExpiration.ALWAYS
            : MuteExpiration.fromDuration(
                DurationMs.fromMilliseconds(change.durationMs)
              )
        );
        break;
      case 'unmute':
        actions.setMuteExpiration(conversationId, MuteExpiration.UNMUTED);
        break;
      case 'pin': {
        const pinned = itemStorage.get('pinnedConversationIds', []);
        if (
          change.value &&
          !pinned.includes(conversationId) &&
          pinned.length >= getPinnedConversationLimit()
        ) {
          return { ok: false, code: ErrorCode.PreconditionFailed };
        }
        actions.setPinned(conversationId, change.value);
        break;
      }
      case 'archive':
        if (change.value) {
          actions.onArchive(conversationId);
        } else {
          actions.onMoveToInbox(conversationId);
        }
        break;
      case 'markUnread':
        actions.onMarkUnread(conversationId);
        break;
      case 'disappearingMessages':
        actions.setDisappearingMessages(
          conversationId,
          DurationInSeconds.fromSeconds(change.seconds)
        );
        break;
      case 'block':
        actions.blockConversation(conversationId);
        break;
      case 'accept':
        actions.acceptConversation(conversationId);
        break;
      case 'delete':
        actions.destroyMessages(conversationId);
        break;
      // Fork addition (decision F36): stored with the chat on this computer
      // only; nothing syncs to the phone.
      case 'photoSource':
        model.set({
          photoSource: change.value === 'auto' ? undefined : change.value,
        });
        drop(DataWriter.updateConversation(model.attributes));
        break;
      default:
        return { ok: false, code: ErrorCode.InvalidArgument };
    }
  } catch (error) {
    log.warn(
      `updateConversation ${change.action} failed`,
      Errors.toLogFormat(error)
    );
    return { ok: false, code: ErrorCode.InternalError };
  }
  log.info(`updateConversation: ${change.action}`);
  return { ok: true, value: {} };
}
