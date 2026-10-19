// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { SignalService as Proto } from '../../protobuf/index.std.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { getAvatar } from '../../util/avatarUtils.preload.ts';
import { getSharedGroupNames } from '../../util/sharedGroupNames.dom.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ConversationDetailsDTO,
  ConversationsGetDetailsParamsType,
  ConversationsGetDetailsResultType,
  DetailsMemberDTO,
  GroupInviteDTO,
  GroupRequestDTO,
  PhotoSourcesDTO,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import {
  getDtoContext,
  getGroupMemberContact,
  getListedConversation,
} from './serviceHelpers.preload.ts';

// Fork addition: Signal's chat details and "About" pages for external
// clients (decision F16). Fields are copied one by one from the same view
// model those pages read, and only where they show them.

const AccessRequired = Proto.AccessControl.AccessRequired;

function access(value: number | undefined): 'all' | 'admins' {
  return value === AccessRequired.ADMINISTRATOR ? 'admins' : 'all';
}

function text(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Fork addition (decision F36): which photos Signal has for this person and
// which one it shows, so the client can say why a chat has no photo.
function getPhotoSources(model: ConversationModel): PhotoSourcesDTO {
  const attrs = model.attributes;
  const shown = getAvatar(attrs);
  return {
    contact: Boolean(attrs.avatar?.path),
    profile: Boolean(attrs.profileAvatar?.path),
    shown: !shown?.path ? null : shown === attrs.avatar ? 'contact' : 'profile',
    choice: attrs.photoSource ?? 'auto',
    preferContactPhotos: itemStorage.get('preferContactAvatars') !== false,
  };
}

export function getDetails({
  conversationId,
}: ConversationsGetDetailsParamsType): ServiceResultType {
  const model =
    getListedConversation(conversationId) ??
    getGroupMemberContact(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const state = window.reduxStore.getState();
  const conversation = state.conversations.conversationLookup[conversationId];
  if (!conversation) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const isGroup = conversation.type === 'group';
  const ourConversationId =
    window.ConversationController.getOurConversationId();

  const members: Array<DetailsMemberDTO> = [];
  const invites: Array<GroupInviteDTO> = [];
  const requests: Array<GroupRequestDTO> = [];
  const areWeAdmin = Boolean(conversation.areWeAdmin);
  if (isGroup) {
    const context = getDtoContext();
    const ourAci =
      window.ConversationController.get(ourConversationId)?.attributes
        .serviceId;
    // As Signal's "Requests and invites" page: invitees you invited by
    // name; others' invitees only as a count per inviter.
    for (const pending of conversation.pendingMemberships ?? []) {
      const member = window.ConversationController.get(pending.serviceId);
      if (!member) {
        continue;
      }
      const inviter = pending.addedByUserId
        ? window.ConversationController.get(pending.addedByUserId)
        : undefined;
      const invitedByMe =
        ourAci !== undefined && pending.addedByUserId === ourAci;
      invites.push({
        conversationId: member.id,
        author: invitedByMe
          ? context.getAuthor(member.id, conversationId, pending.serviceId)
          : null,
        invitedBy: inviter
          ? context.getAuthor(inviter.id, conversationId, pending.addedByUserId)
          : null,
        invitedByMe,
      });
    }
    if (areWeAdmin) {
      for (const pending of conversation.pendingApprovalMemberships ?? []) {
        const member = window.ConversationController.get(pending.aci);
        if (member) {
          requests.push({
            conversationId: member.id,
            author: context.getAuthor(member.id, conversationId, pending.aci),
          });
        }
      }
    }
    for (const membership of conversation.memberships ?? []) {
      const member = window.ConversationController.get(membership.aci);
      if (!member) {
        continue;
      }
      members.push({
        conversationId: member.id,
        author: context.getAuthor(member.id, conversationId, membership.aci),
        admin: membership.isAdmin,
        me: member.id === ourConversationId,
      });
    }
    // As Signal's member list: you first, then by name.
    members.sort(
      (a, b) =>
        Number(b.me) - Number(a.me) ||
        (a.author?.title ?? '').localeCompare(b.author?.title ?? '')
    );
  }

  const otherMembers = members.filter(member => !member.me);
  const canLeave =
    !areWeAdmin ||
    otherMembers.length === 0 ||
    otherMembers.some(member => member.admin);
  const groupLinkEnabled =
    isGroup &&
    conversation.accessControlAddFromInviteLink !== undefined &&
    conversation.accessControlAddFromInviteLink !==
      AccessRequired.UNSATISFIABLE;

  const nickname = [
    conversation.nicknameGivenName,
    conversation.nicknameFamilyName,
  ]
    .filter(Boolean)
    .join(' ');
  const details: ConversationDetailsDTO = {
    conversationId,
    type: isGroup ? 'group' : 'direct',
    title: conversation.title,
    profileName: isGroup ? null : text(conversation.profileName),
    nickname: isGroup ? null : text(nickname),
    note: isGroup ? null : text(conversation.note),
    about: isGroup ? null : text(conversation.about),
    phoneNumber:
      isGroup || conversation.isMe ? null : text(conversation.phoneNumber),
    username: isGroup ? null : text(conversation.username),
    verified:
      !isGroup && !conversation.isMe && Boolean(conversation.isVerified),
    systemContact:
      !isGroup &&
      Boolean(
        conversation.systemGivenName ||
        conversation.systemFamilyName ||
        conversation.systemNickname
      ),
    sharedGroups:
      isGroup || conversation.isMe
        ? []
        : [...getSharedGroupNames(state, conversationId)],
    description: isGroup ? text(conversation.groupDescription) : null,
    members,
    pendingCount: conversation.pendingMemberships?.length ?? 0,
    requestingCount: conversation.pendingApprovalMemberships?.length ?? 0,
    groupLink:
      areWeAdmin && groupLinkEnabled ? text(conversation.groupLink) : null,
    areWeAdmin,
    canEditGroupInfo: Boolean(conversation.canEditGroupInfo),
    canAddMembers: Boolean(conversation.canAddNewMembers),
    invites,
    requests,
    groupLinkEnabled,
    groupLinkApproval:
      groupLinkEnabled &&
      conversation.accessControlAddFromInviteLink ===
        AccessRequired.ADMINISTRATOR,
    addMembersAccess: access(conversation.accessControlMembers),
    editInfoAccess: access(conversation.accessControlAttributes),
    sendMessagesAccess: conversation.announcementsOnly ? 'admins' : 'all',
    canAnnounce:
      isGroup &&
      areWeAdmin &&
      Boolean(
        conversation.announcementsOnly || conversation.announcementsOnlyReady
      ),
    canLeave: isGroup && canLeave,
    photo: isGroup || conversation.isMe ? null : getPhotoSources(model),
  };
  const value: ConversationsGetDetailsResultType = { details };
  return { ok: true, value };
}
