// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationModel } from '../../models/conversations.preload.ts';
import type { DraftBodyRangeMention } from '../../types/BodyRange.std.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ConversationsGetMembersParamsType,
  ConversationsGetMembersResultType,
  GroupMemberDTO,
  SendMentionType,
} from '../protocol.std.ts';
import { ErrorCode, MENTION_PLACEHOLDER } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
} from './serviceHelpers.preload.ts';

// Fork-only: @mentions, as Signal's composer offers and sends them.

type MemberType = Readonly<{
  conversationId: string;
  aci: AciString;
  title: string;
}>;

// The members Signal's mention list offers (MemberRepository): the group's
// members with an ACI, sorted by name, without us.
function getMentionableMembers(model: ConversationModel): Array<MemberType> {
  const members: Array<MemberType> = [];
  for (const member of model.format().sortedGroupMembers ?? []) {
    if (!member.isMe && isAciString(member.serviceId)) {
      members.push({
        conversationId: member.id,
        aci: member.serviceId,
        title: member.title,
      });
    }
  }
  return members;
}

export function getMembers({
  conversationId,
}: ConversationsGetMembersParamsType): ServiceResultType {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const context = getDtoContext();
  const members: Array<GroupMemberDTO> = [];
  for (const member of getMentionableMembers(model)) {
    const author = context.getAuthor(
      member.conversationId,
      conversationId,
      member.aci
    );
    if (author) {
      members.push({ conversationId: member.conversationId, author });
    }
  }
  const value: ConversationsGetMembersResultType = { members };
  return { ok: true, value };
}

// Turns the client's mentions into Signal's body ranges. Undefined when one
// is not at a placeholder or names someone who isn't a member: the send is
// refused rather than sent with a broken mention.
export function toMentionRanges(
  model: ConversationModel,
  body: string,
  mentions: ReadonlyArray<SendMentionType> | undefined
): Array<DraftBodyRangeMention> | undefined {
  if (!mentions || mentions.length === 0) {
    return [];
  }
  const members = new Map(
    getMentionableMembers(model).map(member => [member.conversationId, member])
  );
  const seen = new Set<number>();
  const ranges: Array<DraftBodyRangeMention> = [];
  for (const { start, conversationId } of mentions) {
    const member = members.get(conversationId);
    if (!member || body[start] !== MENTION_PLACEHOLDER || seen.has(start)) {
      return undefined;
    }
    seen.add(start);
    ranges.push({
      start,
      length: 1,
      mentionAci: member.aci,
      replacementText: member.title,
    });
  }
  return ranges;
}
