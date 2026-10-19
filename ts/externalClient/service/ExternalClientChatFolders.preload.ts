// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getCurrentChatFolders,
  getHasAnyCurrentCustomChatFolders,
} from '../../state/selectors/chatFolders.std.ts';
import { ChatFolderType } from '../../types/ChatFolder.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ChatFolderDTO,
  ChatFoldersListResultType,
} from '../protocol.std.ts';
import { getListedConversation } from './serviceHelpers.preload.ts';

// Fork addition (decision F34): Signal's chat folders, in Signal's order.
// As Signal's left pane, none until there is a folder of your own.
export function listChatFolders(): ServiceResultType {
  const state = window.reduxStore.getState();
  const listed = (ids: ReadonlyArray<string>) =>
    ids.filter(id => getListedConversation(id) != null);
  const folders: Array<ChatFolderDTO> = getHasAnyCurrentCustomChatFolders(state)
    ? CurrentChatFolders.toSortedArray(getCurrentChatFolders(state)).map(
        folder => ({
          id: folder.id,
          name: folder.name,
          all: folder.folderType === ChatFolderType.ALL,
          showOnlyUnread: folder.showOnlyUnread,
          showMutedChats: folder.showMutedChats,
          includeAllIndividualChats: folder.includeAllIndividualChats,
          includeAllGroupChats: folder.includeAllGroupChats,
          includedConversationIds: listed(folder.includedConversationIds),
          excludedConversationIds: listed(folder.excludedConversationIds),
        })
      )
    : [];
  const value: ChatFoldersListResultType = { folders };
  return { ok: true, value };
}
