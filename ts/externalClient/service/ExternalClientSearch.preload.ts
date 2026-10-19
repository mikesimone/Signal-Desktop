// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader } from '../../sql/Client.preload.ts';
import type { ClientSearchResultMessageType } from '../../sql/Interface.std.ts';
import { getAllConversations } from '../../state/selectors/conversations.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import { isNotNil } from '../../util/isNotNil.std.ts';
import { searchConversationTitles } from '../../util/searchConversationTitles.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import { locateSnippet } from '../searchSnippet.std.ts';
import type {
  MessagesSearchParamsType,
  MessagesSearchResultType,
  SearchResultDTO,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
  preferCached,
} from './serviceHelpers.preload.ts';

// Fork addition: Signal's message search for external clients (decision
// F17). The same steps as Signal's search box (ducks/search doSearch): the
// full-text query, plus messages mentioning contacts whose names match.

const log = createLogger('ExternalClientSearch');

// As Signal's doSearch.
const MAX_MATCHING_CONTACTS = 100;

export async function searchMessages({
  query,
  conversationId,
  limit,
  onlyUnread = false,
}: MessagesSearchParamsType): Promise<ServiceResultType> {
  if (conversationId !== undefined && !getListedConversation(conversationId)) {
    return { ok: false, code: ErrorCode.NotFound };
  }

  const segmenter = new Intl.Segmenter([], { granularity: 'word' });
  const queryWords = [...segmenter.segment(query)]
    .filter(word => word.isWordLike)
    .map(word => word.segment);
  const contactServiceIdsMatchingQuery = searchConversationTitles(
    getAllConversations(window.reduxStore.getState()),
    queryWords
  )
    .filter(conversation => conversation.type === 'direct')
    .map(conversation => conversation.serviceId)
    .filter(isNotNil)
    .slice(0, MAX_MATCHING_CONTACTS);

  let found: ReadonlyArray<ClientSearchResultMessageType>;
  try {
    found = await DataReader.searchMessages({
      query,
      conversationId,
      options: limit === undefined ? undefined : { limit },
      contactServiceIdsMatchingQuery,
      filterByUnread: onlyUnread,
    });
  } catch (error) {
    // Signal's search box shows no results for a query FTS can't parse.
    log.warn('searchMessages failed', Errors.toLogFormat(error));
    found = [];
  }

  const context = getDtoContext();
  const results = new Array<SearchResultDTO>();
  for (const result of found) {
    if (!getListedConversation(result.conversationId)) {
      continue;
    }
    const message = toMessageDTO(preferCached(result), context);
    // Deleted, view-once and expired messages show nothing.
    if (!message?.body) {
      continue;
    }
    const located = locateSnippet(message.body, result.snippet);
    results.push({
      message,
      snippet: located?.snippet ?? null,
      highlights: located?.highlights ?? [],
    });
  }

  const value: MessagesSearchResultType = { results };
  return { ok: true, value };
}
