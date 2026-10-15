// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The Backchannel chat page. Talks only to the Backchannel helper that
// served it (same origin; the token is part of the page's own path).
// All text from Signal goes into the page through textContent, never HTML.

'use strict';

const $ = id => document.getElementById(id);

const conversations = new Map();
// conversationId -> AuthorDTO, from messages (group members usually have no
// listed conversation of their own).
const authors = new Map();
let capabilities = [];
// conversationId -> [{ authorConversationId, author }], from typing.changed.
const typingIn = new Map();
// The chat list shows archived chats instead (Signal's "Archived chats").
let showArchived = false;
let selectedId = null;
let messages = new Map();
let nextCursor = null;
// Set after jumping to an older message (a search result): the newest
// messages aren't loaded, and this pages toward them.
let newerCursor = null;
let loadingNewer = false;
// Signal's "N unread messages" line, placed when the chat is opened:
// { messageId, count }.
let unreadLine = null;
let unreadLineEl = null;
// While a chat is opening, before it's scrolled to where it opens.
let opening = false;
let bridgeState = 'offline';
let helperConnected = false;
let markReadInFlight = false;
// A mark-read was asked for while one was in flight: run again after.
let markReadAgain = false;
let replyTo = null;
// "Reply privately" links for the open chat (decision F23): group message
// id -> link, and direct-chat reply id -> link.
let privateLinks = { byGroupMessage: new Map(), byReply: new Map() };
// The message being edited, if any.
let editing = null;
let preferredReactions = null;
const expiryTimers = new Map();

const AVATAR_COLORS = [
  'A100',
  'A110',
  'A120',
  'A130',
  'A140',
  'A150',
  'A160',
  'A170',
  'A180',
  'A190',
  'A200',
  'A210',
];

const BANNERS = {
  offline:
    "Can't reach Signal. Make sure Signal is running and Settings > " +
    'Privacy > Apps on this computer is on. Retrying…',
  unlinked: 'Link Signal to your phone first, then approve "Backchannel".',
  awaitingApproval: 'Approve "Backchannel" in the Signal window.',
  denied: 'Signal did not allow this app.',
  keyMismatch:
    "Signal's identity key changed since this app was approved. Delete " +
    'key.json in the Backchannel config folder and restart it to pair again.',
  loading: 'Loading chats…',
};

const SEND_ERRORS = {
  proxyTooLarge:
    'Not sent: the web server in front of the helper refused a file this big (HTTP 413). Raise its upload limit (nginx: client_max_body_size).',
  expired: 'This version of Signal has expired. Update Signal.',
  invalidConversation: "Signal can't send to this chat.",
  blocked: 'You blocked this chat. Unblock it in Signal to send.',
  leftGroup: "You're no longer in this group.",
  messageRequest: 'Accept the message request in Signal first.',
  unregistered: 'This person is no longer on Signal.',
  profileSharingRequired: 'Open this chat in Signal and accept it first.',
  pendingApproval: 'Your request to join this group is still pending.',
  announcementOnly: 'Only admins can send messages to this group.',
  terminated: 'This group is no longer active.',
  untrustedIdentity:
    "This person's safety number changed. Open the chat in Signal to review it.",
  tooLong: 'That message is too long.',
  attachmentTooLarge: 'That file is too large for Signal.',
  notForwardable: "Signal can't forward this message.",
  notDownloaded:
    'Signal is still downloading this message. Try again in a moment.',
  notFound: 'That chat is gone.',
  pollsNotSupported: "Signal doesn't send polls to 1:1 chats yet.",
  pollEnded: 'This poll has ended.',
};

const STATUS_TEXT = {
  sending: 'Sending…',
  paused: 'Paused: open Signal',
  failed: 'Not sent',
  partiallySent: 'Partly sent',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  viewed: 'Viewed',
};

async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code;
    error.reason = data.error?.reason;
    throw error;
  }
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// --- icons (built as DOM; the CSP allows no inline markup) ----------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  react:
    'M12 21.5a9.5 9.5 0 1 1 9.5-9.5M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01M19 15v6M16 18h6',
  reply: 'M10 5 4 11l6 6M4 11h10a6 6 0 0 1 6 6v2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  group:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.5 3.5 5.2',
  note: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7',
  play: 'M8 5v14l11-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  filter: 'M4 7h16M7 12h10M10 17h4',
  attach:
    'M20 11.5 12.4 19a5 5 0 0 1-7-7l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4L15 6.9',
  forward: 'M14 5l6 6-6 6M20 11H10a6 6 0 0 0-6 6v2',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM16 16l4.5 4.5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  poll: 'M5 20V11M12 20V4M19 20v-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  media: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  goto: 'M5 12h14M13 6l6 6-6 6',
  down: 'M12 5v14M5 12l7 7 7-7',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 9v4l2.5 2M10 2h4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  pin: 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6',
  unpin: 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6M4 4l16 16',
  unread: 'M4 6h11M4 12h9M4 18h11M19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  sticker:
    'M20 12V8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h4m8-8-8 8m8-8h-4a4 4 0 0 0-4 4v4',
  'cat-recent': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  'cat-smileys':
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01',
  'cat-animals':
    'M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 20c-4 0-6-2.5-6-6s2.7-6 6-6 6 2.5 6 6-2 6-6 6Z',
  'cat-food':
    'M4 11h16M5 11a7 5 0 0 1 14 0M4 15h16M5 15v1a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-1',
  'cat-activities':
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  'cat-travel': 'M5 16v-5l2-5h10l2 5v5M3 16h18v2H3zM7 19v1M17 19v1M5 11h14',
  'cat-objects':
    'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.4.4.5.9.5 1.4V16h6v-.7c0-.5.2-1 .5-1.4A6 6 0 0 0 12 3Z',
  'cat-symbols':
    'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z',
  'cat-flags': 'M5 21V4M5 4h11l-2 4 2 4H5',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// --- avatars -------------------------------------------------------------

function initials(title) {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words.at(-1)][0] ?? '') : '';
  return (first + last).toUpperCase();
}

function colorFor(id, avatarColor) {
  if (AVATAR_COLORS.includes(avatarColor)) {
    return avatarColor;
  }
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// who: { title, avatarColor, avatarVersion }; kind: 'direct' | 'group' | 'me'
function avatar(id, who, size, kind = 'direct') {
  const box = el(
    'span',
    `avatar av-${size} ac-${colorFor(id, who.avatarColor)}`
  );
  const fallback = () => {
    if (kind === 'group') {
      box.append(icon('group'));
    } else if (kind === 'me') {
      box.append(icon('note'));
    } else {
      const text = initials(who.title);
      box.append(text ? el('span', 'initials', text) : icon('group'));
    }
  };
  fallback();
  if (who.avatarVersion) {
    // In the DOM from the start so lazy loading can see it; shown over the
    // initials once loaded.
    const img = el('img', 'photo');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    box.append(img);
    const params = new URLSearchParams({
      conversationId: id,
      v: who.avatarVersion,
    });
    img.src = `api/avatar?${params}`;
  }
  return box;
}

function conversationAvatar(c, size) {
  return avatar(
    c.id,
    c,
    size,
    c.noteToSelf ? 'me' : c.type === 'group' ? 'group' : 'direct'
  );
}

// --- banner and title ------------------------------------------------------

function renderBanner() {
  const banner = $('banner');
  const action = $('banner-action');
  let text = null;
  if (!helperConnected) {
    // A restart (an update, a redeploy) takes a few seconds; only a long
    // outage means the helper is really down.
    const long =
      disconnectedSince !== null &&
      Date.now() - disconnectedSince > HELPER_DOWN_AFTER_MS;
    text = long
      ? "The Backchannel helper isn't running. Retrying…"
      : 'Connecting…';
  } else if (bridgeState !== 'ready') {
    text = BANNERS[bridgeState] ?? `Signal: ${bridgeState}`;
  }
  banner.hidden = text === null;
  $('banner-text').textContent = text ?? '';
  action.hidden = !(helperConnected && bridgeState === 'denied');
  action.textContent = 'Ask Signal again';
}

function unreadTotal() {
  let total = 0;
  for (const c of conversations.values()) {
    if (c.muted || c.archived) {
      continue;
    }
    total += c.unreadCount > 0 ? c.unreadCount : c.markedUnread ? 1 : 0;
  }
  return total;
}

// Rambox reads the unread badge from "(N)" at the start of the title.
function renderTitle() {
  const total = unreadTotal();
  document.title = total > 0 ? `(${total}) Backchannel` : 'Backchannel';
}

// --- conversation list -----------------------------------------------------

function displayTitle(c) {
  return c.noteToSelf ? 'Note to Self' : c.title;
}

// The chat list filters, as in Signal: a tab ('all' | 'direct' | 'group')
// and the unread filter button, which combine.
let listFilter = 'all';
let unreadOnly = false;
try {
  listFilter = localStorage.getItem('listFilter') ?? 'all';
  unreadOnly = localStorage.getItem('unreadOnly') === '1';
} catch {
  // Storage blocked; keep the defaults.
}

function isUnread(c) {
  return c.unreadCount > 0 || c.markedUnread;
}

const FILTERS = {
  all: () => true,
  direct: c => c.type === 'direct',
  group: c => c.type === 'group',
};

function keepConversation(c) {
  const tab = FILTERS[listFilter] ?? FILTERS.all;
  // The open chat stays listed while you read it, as in Signal.
  return tab(c) && (!unreadOnly || isUnread(c) || c.id === selectedId);
}

function sortedConversations() {
  const query = $('search').value.trim().toLowerCase();
  return [...conversations.values()]
    .filter(c =>
      query
        ? displayTitle(c).toLowerCase().includes(query) ||
          c.title.toLowerCase().includes(query)
        : c.archived === showArchived
    )
    .filter(keepConversation)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinnedIndex ?? 0) - (b.pinnedIndex ?? 0) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    );
}

function shortTime(ms) {
  if (!ms) {
    return '';
  }
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) {
    return 'Now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (Date.now() - ms < 6 * 24 * 3600_000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Rows are kept per conversation so photos are not reloaded on every update.
const rowCache = new Map();

function conversationRow(c) {
  const unread = c.unreadCount > 0 || c.markedUnread;
  const key = JSON.stringify([
    c.title,
    c.avatarVersion,
    c.avatarColor,
    c.unreadCount,
    c.markedUnread,
    c.muted,
    c.lastActivityAt,
    c.id === selectedId,
    shortTime(c.lastActivityAt),
    c.lastMessage,
    typingIn.has(c.id),
  ]);
  const cached = rowCache.get(c.id);
  if (cached && cached.key === key) {
    return cached.li;
  }
  const li = el('li');
  li.dataset.id = c.id;
  li.title = displayTitle(c);
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(c.id === selectedId));
  li.className = [unread ? 'unread' : '', c.muted ? 'muted' : ''].join(' ');
  const text = el('span', 'row-text');
  const top = el('span', 'row-top');
  top.append(
    el('span', 'title', displayTitle(c)),
    el('span', 'time', shortTime(c.lastActivityAt))
  );
  const bottom = el('span', 'row-bottom');
  if (typingIn.has(c.id)) {
    // As Signal's list: the dots take the preview's place.
    bottom.append(typingDots());
  } else {
    bottom.append(el('span', 'preview', previewLine(c)));
  }
  if (c.lastMessage?.status && !typingIn.has(c.id)) {
    bottom.append(statusIcon(c.lastMessage.status));
  }
  text.append(top, bottom);
  li.append(conversationAvatar(c, 48), text);
  if (unread) {
    li.append(
      el('span', 'badge', c.unreadCount > 0 ? String(c.unreadCount) : '')
    );
  }
  li.addEventListener('click', () => selectConversation(c.id));
  // As Signal's chat list: right-click for the chat's menu.
  li.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openChatMenu(c.id, {
      left: ev.clientX,
      right: ev.clientX,
      top: ev.clientY,
      bottom: ev.clientY,
      width: 0,
      height: 0,
    });
  });
  rowCache.set(c.id, { key, li });
  return li;
}

// Signal's checkmarks: one circle sent, two delivered, two filled read.
function statusIcon(status) {
  const label = STATUS_TEXT[status] ?? status;
  const span = el('span', `status-icon st-${status}`);
  span.title = label;
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', label);
  return span;
}

// The second line of a chat list row, as Signal writes it.
function previewLine(c) {
  const last = c.lastMessage;
  if (!last) {
    return '';
  }
  if (last.deleted) {
    return 'This message was deleted';
  }
  const text = (last.text ?? '').replace(/\s+/g, ' ');
  return last.author && c.type === 'group' ? `${last.author}: ${text}` : text;
}

const sectionHeads = {};
function sectionHead(label) {
  sectionHeads[label] ??= el('li', 'section-head', label);
  return sectionHeads[label];
}

function setListFilter(name, unread) {
  listFilter = name;
  unreadOnly = unread;
  try {
    localStorage.setItem('listFilter', name);
    localStorage.setItem('unreadOnly', unread ? '1' : '0');
  } catch {
    // Storage blocked; the filter still applies until reload.
  }
  renderConversations();
}

// Tabs under the search box, with Signal's unread counts. The filter button
// beside the search box is the unread filter.
function renderFilters() {
  const unarchived = [...conversations.values()].filter(c => !c.archived);
  const unreadIn = test => unarchived.filter(c => test(c) && isUnread(c));
  const tabs = [
    ['all', 'All chats', unreadIn(FILTERS.all).length],
    ['direct', '1:1 chats', unreadIn(FILTERS.direct).length],
    ['group', 'Groups', unreadIn(FILTERS.group).length],
  ];
  $('filters').replaceChildren(
    ...tabs.map(([name, label, count]) => {
      const tab = el('button', 'filter-tab');
      tab.type = 'button';
      tab.setAttribute('aria-pressed', String(listFilter === name));
      tab.append(el('span', '', label));
      if (count > 0) {
        tab.append(el('span', 'filter-count', String(count)));
      }
      tab.addEventListener('click', () => setListFilter(name, unreadOnly));
      return tab;
    })
  );
  $('filter-unread').setAttribute('aria-pressed', String(unreadOnly));
}

function renderConversations() {
  renderFilters();
  const searching = $('search').value.trim() !== '';
  // Searching in one chat finds only its messages, as in Signal.
  const list = searching && searchScope ? [] : sortedConversations();
  const pinned = list.filter(c => c.pinned);
  const others = list.filter(c => !c.pinned);
  const rows = searching
    ? [
        ...(list.length > 0 ? [sectionHead('Chats')] : []),
        ...list.map(conversationRow),
        ...searchRows(list.length),
      ]
    : pinned.length === 0
      ? list.map(conversationRow)
      : [
          sectionHead('Pinned'),
          ...pinned.map(conversationRow),
          ...(others.length > 0 ? [sectionHead('Chats')] : []),
          ...others.map(conversationRow),
        ];
  if (rows.length === 0 && bridgeState === 'ready') {
    rows.push(
      el(
        'li',
        'list-empty',
        showArchived
          ? 'No archived chats'
          : unreadOnly
            ? 'No unread chats'
            : 'No chats'
      )
    );
  }
  if (showArchived) {
    rows.unshift(archivedHead());
  } else if (!searching) {
    const archived = [...conversations.values()].filter(c => c.archived);
    if (archived.length > 0) {
      rows.push(archivedLink(archived.length));
    }
  }
  $('conversations').replaceChildren(...rows);
}

// --- new chat and new group (Signal's compose button) -----------------------

// 'chat' | 'members' | 'info' while the dialog is open, or 'add' when
// adding members to a group from its details.
let composeStep = null;
// While adding members: { conversationId, exclude: Set of member ids }.
let addingTo = null;
let composeContacts = [];
const groupMembers = new Map();
let groupPhoto = null;
let groupPhotoUrl = null;

function canCreateChats() {
  return capabilities.includes('conversations.create');
}

// What Signal's search finds people by: a username (name.01) or a number.
function looksFindable(query) {
  return (
    /^@?[a-z_][a-z0-9_]{2,31}\.\d{2,10}$/i.test(query) ||
    /^\+?[\d\s().-]{6,20}$/.test(query)
  );
}

function contactAsChat(contact) {
  return {
    id: contact.conversationId,
    type: 'direct',
    title: contact.title,
    avatarColor: contact.avatarColor,
    avatarVersion: contact.avatarVersion,
    noteToSelf: contact.noteToSelf,
  };
}

function matchesContact(contact, query) {
  const q = query.toLowerCase().replace(/^@/, '');
  return (
    !q ||
    contact.title.toLowerCase().includes(q) ||
    (contact.username ?? '').toLowerCase().includes(q) ||
    (contact.phoneNumber ?? '')
      .replace(/[^\d+]/g, '')
      .includes(q.replace(/[^\d+]/g, '') || '\u0000')
  );
}

async function openNewChat() {
  if (!capabilities.includes('contacts.read') || !canCreateChats()) {
    toast('Allow this page to start new chats in Signal to use this.');
    return;
  }
  groupMembers.clear();
  clearGroupPhoto();
  $('new-group-name').value = '';
  $('new-chat').hidden = false;
  await showComposeStep('chat');
}

function closeNewChat() {
  const returnTo = addingTo?.conversationId;
  composeStep = null;
  addingTo = null;
  $('new-chat').hidden = true;
  clearGroupPhoto();
  if (returnTo) {
    openDetails(returnTo);
  }
}

// Signal's "Add members" on a group's details page.
async function openAddMembers(c, d) {
  groupMembers.clear();
  addingTo = {
    conversationId: c.id,
    exclude: new Set([
      ...d.members.map(m => m.conversationId),
      ...d.invites.map(i => i.conversationId),
    ]),
  };
  closeDetails();
  $('new-chat').hidden = false;
  await showComposeStep('add');
}

async function showComposeStep(step) {
  composeStep = step;
  const picking = step !== 'info';
  $('new-chat-title').textContent =
    step === 'chat'
      ? 'New chat'
      : step === 'members' || step === 'add'
        ? 'Add members'
        : 'Name this group';
  $('new-chat-back').hidden = step === 'chat' || step === 'add';
  $('new-chat-pick').hidden = !picking;
  $('new-group-info').hidden = picking;
  $('new-chat-foot').hidden = step === 'chat';
  $('new-chat-next').textContent = step === 'info' ? 'Create' : 'Next';
  if (picking) {
    $('new-chat-search').value = '';
    $('new-chat-search').placeholder =
      step === 'chat' ? 'Name, username or number' : 'Search contacts';
    try {
      const { contacts } = await api(
        `api/contacts${step === 'chat' ? '' : '?forGroup=1'}`
      );
      composeContacts =
        step === 'add'
          ? contacts.filter(c => !addingTo.exclude.has(c.conversationId))
          : contacts;
    } catch (error) {
      toast(`Couldn't load contacts (${error.code ?? error.message}).`);
      composeContacts = [];
    }
    renderComposeList();
    $('new-chat-search').focus();
  } else {
    renderGroupInfo();
    $('new-group-name').focus();
  }
}

function composeRow(chat, label, sub, onClick) {
  const li = el('li');
  li.append(conversationAvatar(chat, 36));
  const text = el('span', 'row-text');
  text.append(el('span', 'title', label));
  if (sub) {
    text.append(el('span', 'sub', sub));
  }
  li.append(text);
  li.addEventListener('click', onClick);
  return li;
}

function renderComposeList() {
  const query = $('new-chat-search').value.trim();
  const found = composeContacts.filter(c => matchesContact(c, query));
  const rows = [];
  if (composeStep === 'chat') {
    if (!query) {
      rows.push(
        composeRow(
          { id: 'new-group', type: 'group', title: 'New group' },
          'New group',
          null,
          () => showComposeStep('members')
        )
      );
    }
    if (query && looksFindable(query)) {
      rows.push(
        composeRow(
          { id: 'find', type: 'direct', title: query.replace(/^@/, '') },
          `Find ${query}`,
          'Look up this username or phone number in Signal',
          () => findAndOpen(query)
        )
      );
    }
    for (const contact of found) {
      rows.push(
        composeRow(
          contactAsChat(contact),
          contact.noteToSelf ? 'Note to Self' : contact.title,
          contact.about ?? contact.username ?? null,
          () => openContact(contact.conversationId)
        )
      );
    }
  } else {
    for (const contact of found) {
      const li = el('li');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = groupMembers.has(contact.conversationId);
      li.append(
        box,
        conversationAvatar(contactAsChat(contact), 36),
        el('span', 'title', contact.title)
      );
      li.classList.toggle('checked', box.checked);
      li.addEventListener('click', e => {
        if (e.target !== box) {
          box.checked = !box.checked;
        }
        if (box.checked) {
          groupMembers.set(contact.conversationId, contact);
        } else {
          groupMembers.delete(contact.conversationId);
        }
        renderComposeList();
      });
      rows.push(li);
    }
  }
  if (rows.length === 0) {
    rows.push(el('li', 'list-empty', 'No contacts found'));
  }
  $('new-chat-list').replaceChildren(...rows);
  renderMemberChips();
}

function renderMemberChips() {
  const chips = $('new-chat-chips');
  const picking = composeStep === 'members' || composeStep === 'add';
  chips.hidden = !picking || groupMembers.size === 0;
  chips.replaceChildren(
    ...[...groupMembers.values()].map(contact => {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.title = `Remove ${contact.title}`;
      chip.append(el('span', '', contact.title), icon('close'));
      chip.addEventListener('click', () => {
        groupMembers.delete(contact.conversationId);
        renderComposeList();
      });
      return chip;
    })
  );
  const count = groupMembers.size;
  $('new-chat-count').textContent = picking
    ? `${count} member${count === 1 ? '' : 's'}`
    : '';
  if (composeStep === 'members') {
    $('new-chat-next').textContent = count === 0 ? 'Skip' : 'Next';
    $('new-chat-next').disabled = false;
  } else if (composeStep === 'add') {
    $('new-chat-next').textContent = 'Add';
    $('new-chat-next').disabled = count === 0;
  }
}

function renderGroupInfo() {
  const timer = $('new-group-timer');
  if (timer.options.length === 0) {
    timer.append(
      ...TIMER_CHOICES.map(([seconds, label]) => {
        const option = el('option', '', label);
        option.value = String(seconds);
        return option;
      })
    );
  }
  const count = groupMembers.size;
  $('new-group-members').textContent =
    count === 0
      ? 'Just you, for now.'
      : `You and ${[...groupMembers.values()].map(c => c.title).join(', ')}`;
  renderGroupPhoto();
  updateGroupNext();
}

function groupNameLength() {
  return [...segmenter.segment($('new-group-name').value.trim())].length;
}

function updateGroupNext() {
  if (composeStep !== 'info') {
    return;
  }
  const length = groupNameLength();
  // Signal's limit for a group name.
  $('new-chat-next').disabled = length === 0 || length > 32;
  $('new-chat-count').textContent = length > 0 ? `${length}/32` : '';
}

function renderGroupPhoto() {
  const button = $('new-group-photo');
  if (groupPhotoUrl) {
    const img = el('img');
    img.src = groupPhotoUrl;
    img.alt = '';
    button.replaceChildren(img);
  } else {
    button.replaceChildren(icon('group'));
  }
}

function clearGroupPhoto() {
  if (groupPhotoUrl) {
    URL.revokeObjectURL(groupPhotoUrl);
  }
  groupPhoto = null;
  groupPhotoUrl = null;
}

// The chat becomes part of the list, then opens, as from Signal's composer.
async function showOpened(conversation) {
  conversations.set(conversation.id, conversation);
  closeNewChat();
  renderConversations();
  await selectConversation(conversation.id);
}

async function openContact(conversationId) {
  if (conversations.has(conversationId)) {
    closeNewChat();
    await selectConversation(conversationId);
    return;
  }
  try {
    const { conversation } = await api('api/open', { conversationId });
    await showOpened(conversation);
  } catch (error) {
    toast(`Couldn't open the chat (${error.code ?? error.message}).`);
  }
}

async function findAndOpen(query) {
  try {
    const { conversation } = await api('api/find', { query });
    await showOpened(conversations.get(conversation.id) ?? conversation);
  } catch (error) {
    toast(
      error.code === 'NOT_FOUND'
        ? `${query} isn't a Signal user.`
        : error.code === 'INVALID_ARGUMENT'
          ? 'Enter a username like name.01, or a phone number.'
          : `Couldn't look that up (${error.code ?? error.message}).`
    );
  }
}

async function composeNext() {
  if (composeStep === 'add') {
    if (groupMembers.size === 0) {
      return;
    }
    $('new-chat-next').disabled = true;
    const ok = await changeGroup(addingTo.conversationId, {
      action: 'addMembers',
      memberIds: [...groupMembers.keys()],
    });
    if (ok) {
      closeNewChat();
    } else {
      $('new-chat-next').disabled = false;
    }
    return;
  }
  if (composeStep === 'members') {
    await showComposeStep('info');
    return;
  }
  if (composeStep !== 'info' || $('new-chat-next').disabled) {
    return;
  }
  const group = {
    name: $('new-group-name').value.trim(),
    memberIds: [...groupMembers.keys()],
    disappearingSeconds: Number($('new-group-timer').value),
  };
  $('new-chat-next').disabled = true;
  try {
    const res = await fetch(
      `api/groups?${new URLSearchParams({ group: JSON.stringify(group) })}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: groupPhoto ?? new Blob([]),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: data.error?.code,
      });
    }
    await showOpened(data.conversation);
  } catch (error) {
    toast(`Couldn't create the group (${error.code ?? error.message}).`);
    updateGroupNext();
  }
}

// --- message search (Signal's search box) -----------------------------------

// Searching in one chat (from its menu), or null for all chats.
let searchScope = null;
// The last answer: { query, scope, results } or { ..., error }.
let searchAnswer = null;
let searchTimer = null;
let searchSeq = 0;

function currentSearch() {
  return { query: $('search').value.trim(), scope: searchScope };
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  const { query } = currentSearch();
  if (!query) {
    searchAnswer = null;
    return;
  }
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const { query, scope } = currentSearch();
  if (!query) {
    return;
  }
  const seq = ++searchSeq;
  const params = new URLSearchParams({ q: query });
  if (scope) {
    params.set('conversationId', scope);
  }
  let answer;
  try {
    const { results } = await api(`api/search?${params}`);
    answer = { query, scope, results };
  } catch (error) {
    answer = { query, scope, results: [], error };
  }
  if (seq === searchSeq) {
    searchAnswer = answer;
    renderConversations();
  }
}

function searchRows(chatCount) {
  const { query, scope } = currentSearch();
  const answer =
    searchAnswer?.query === query && searchAnswer.scope === scope
      ? searchAnswer
      : null;
  if (!answer) {
    return [sectionHead('Messages'), el('li', 'list-empty', 'Searching…')];
  }
  if (answer.error) {
    return [
      sectionHead('Messages'),
      el(
        'li',
        'list-empty',
        `Couldn't search (${answer.error.code ?? answer.error.message}).`
      ),
    ];
  }
  if (answer.results.length === 0) {
    return chatCount > 0
      ? []
      : [el('li', 'list-empty', `No results for "${query}"`)];
  }
  return [sectionHead('Messages'), ...answer.results.map(searchResultRow)];
}

// The snippet as Signal shows it: the matched part of the body, with the
// message's own mentions and styles and the matched words in bold.
function renderSnippet(result) {
  const { message, snippet, highlights } = result;
  const body = message.body ?? '';
  const start = snippet?.start ?? 0;
  const end = snippet ? start + snippet.length : body.length;
  const shift = ranges =>
    (ranges ?? []).flatMap(r => {
      const from = Math.max(start, r.start);
      const to = Math.min(end, r.start + r.length);
      return to > from
        ? [{ ...r, start: from - start, length: to - from }]
        : [];
    });
  const part = renderBody({
    body: body.slice(start, end),
    mentions: shift(message.mentions),
    formatting: [
      ...shift(message.formatting),
      ...shift(highlights.map(r => ({ ...r, style: 'highlight' }))),
    ],
  });
  part.classList.add('snippet');
  if (start > 0) {
    part.prepend('…');
  }
  if (end < body.length) {
    part.append('…');
  }
  return part;
}

function searchResultRow(result) {
  const m = result.message;
  const c = conversations.get(m.conversationId);
  const li = el('li', 'search-result');
  li.setAttribute('role', 'option');
  const from =
    m.direction === 'outgoing'
      ? 'You'
      : (m.author?.title ?? nameOf(m.authorConversationId));
  const where = c ? displayTitle(c) : 'Unknown chat';
  const title =
    c?.type === 'group'
      ? `${from} in ${where}`
      : m.direction === 'outgoing' && !c?.noteToSelf
        ? `You to ${where}`
        : where;
  const text = el('span', 'row-text');
  const top = el('span', 'row-top');
  top.append(
    el('span', 'title', title),
    el('span', 'time', shortTime(m.sentAt))
  );
  text.append(top, renderSnippet(result));
  li.title = title;
  li.append(c ? conversationAvatar(c, 48) : el('span', 'avatar'), text);
  li.addEventListener('click', () => jumpToMessage(m));
  return li;
}

function renderSearchScope() {
  const box = $('search-scope');
  const c = searchScope ? conversations.get(searchScope) : null;
  box.hidden = !c;
  $('search').placeholder = c ? 'Search messages in this chat' : 'Search';
  if (!c) {
    box.replaceChildren();
    return;
  }
  const close = el('button', 'icon-button');
  close.type = 'button';
  close.title = 'Search all chats';
  close.setAttribute('aria-label', 'Search all chats');
  close.append(icon('close'));
  close.addEventListener('click', () => endChatSearch());
  box.replaceChildren(el('span', '', `In ${displayTitle(c)}`), close);
}

// As Signal's "Search in chat".
function startChatSearch(conversationId) {
  searchScope = conversationId;
  $('search').value = '';
  searchAnswer = null;
  renderSearchScope();
  document.querySelector('.sidebar').classList.add('expanded');
  $('search').focus();
  renderConversations();
}

function endChatSearch() {
  searchScope = null;
  renderSearchScope();
  scheduleSearch();
  renderConversations();
}

// Opens a search result's chat at that message, loading the messages
// around it, as Signal does.
async function jumpToMessage(target) {
  collapseSidebar();
  if (selectedId !== target.conversationId) {
    await selectConversation(target.conversationId);
  }
  if (selectedId !== target.conversationId) {
    return;
  }
  if (!messages.has(target.id)) {
    const conversationId = selectedId;
    const older = new URLSearchParams({ conversationId, cursor: target.id });
    const newer = new URLSearchParams({
      conversationId,
      cursor: target.id,
      newer: '1',
    });
    let pages;
    try {
      pages = await Promise.all([
        api(`api/messages?${older}`),
        api(`api/messages?${newer}`),
      ]);
    } catch (error) {
      toast(`Couldn't load messages (${error.code ?? error.message}).`);
      return;
    }
    if (conversationId !== selectedId) {
      return;
    }
    messages = new Map();
    clearExpiryTimers();
    putMessage(target);
    for (const m of [...pages[0].messages, ...pages[1].messages]) {
      putMessage(m);
    }
    nextCursor = pages[0].nextCursor;
    newerCursor = pages[1].nextCursor;
    renderMessages({ keepBottom: false });
  }
  flashMessage(target.id);
  maybeMarkRead();
}

// Back to the newest messages after a jump, as Signal's scroll-down button.
async function showLatest() {
  const conversationId = selectedId;
  messages = new Map();
  clearExpiryTimers();
  nextCursor = null;
  newerCursor = null;
  try {
    await loadMessages();
  } catch (error) {
    toast(`Couldn't load messages (${error.code ?? error.message}).`);
    return;
  }
  if (conversationId === selectedId) {
    $('messages').scrollTop = $('messages').scrollHeight;
    maybeMarkRead();
  }
}

// --- messages --------------------------------------------------------------

function authorOf(conversationId) {
  if (!conversationId) {
    return null;
  }
  const c = conversations.get(conversationId);
  return authors.get(conversationId) ?? c ?? null;
}

function nameOf(conversationId) {
  return authorOf(conversationId)?.title ?? 'Someone';
}

function rememberAuthors(m) {
  if (m.authorConversationId && m.author) {
    authors.set(m.authorConversationId, m.author);
  }
  if (m.quote?.authorConversationId && m.quote.author) {
    authors.set(m.quote.authorConversationId, m.quote.author);
  }
}

function describeAttachments(attachments) {
  return attachments.map(a => {
    const type = a.contentType.split('/')[0];
    const label =
      type === 'image'
        ? 'Photo'
        : type === 'video'
          ? 'Video'
          : type === 'audio'
            ? 'Audio'
            : 'File';
    return a.fileName ? `${label}: ${a.fileName}` : label;
  });
}

// Plain-text summary for notifications and quotes.
function summarize(m) {
  switch (m.kind) {
    case 'text': {
      if (m.body) {
        return m.body;
      }
      return describeAttachments(m.attachments).join(', ') || 'Message';
    }
    case 'sticker':
      return 'Sticker';
    case 'poll':
      return `Poll: ${m.poll?.question ?? ''}`;
    case 'viewOnce':
      return 'View-once media';
    case 'deleted':
      return 'This message was deleted';
    default:
      return 'Open Signal to see this message';
  }
}

function formatTime(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

// Signal shows short emoji-only messages large and without a bubble.
const segmenter = new Intl.Segmenter();
function isJumbo(body) {
  if (
    !body ||
    body.length > 40 ||
    !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(body)
  ) {
    return false;
  }
  const graphemes = [...segmenter.segment(body.trim())].filter(
    s => s.segment.trim() !== ''
  );
  return (
    graphemes.length > 0 &&
    graphemes.length <= 3 &&
    graphemes.every(s => /\p{Extended_Pictographic}/u.test(s.segment))
  );
}

function nameLine(name, author, className) {
  const line = el('span', className);
  if (author?.nameColor) {
    line.classList.add(`nc-${author.nameColor}`);
  }
  line.append(el('span', 'name', name));
  if (author?.label) {
    const pill = el('span', 'pill');
    if (author.label.emoji) {
      pill.append(el('span', 'pill-emoji', author.label.emoji));
    }
    pill.append(el('span', 'pill-text', author.label.text));
    line.append(pill);
  }
  return line;
}

// As Signal: a click on a reply's quote scrolls to the original, loading
// older messages until it's there, and highlights it briefly.
const MAX_QUOTE_PAGES = 50;
let quoteJump = 0;

function findQuoted(quote) {
  return sortedMessages().find(
    m =>
      m.sentAt === quote.sentAt &&
      (quote.authorConversationId === null ||
        m.authorConversationId === quote.authorConversationId)
  );
}

async function jumpToQuote(quote, m) {
  const conversationId = selectedId;
  const jump = ++quoteJump;
  let found = findQuoted(quote);
  // A reply that quotes a message from another chat ("Reply privately"):
  // Signal knows where it is.
  if (!found && m && conversations.get(conversationId)?.type === 'direct') {
    try {
      const where = await api(
        `api/locateQuote?${new URLSearchParams({ messageId: m.id })}`
      );
      if (jump !== quoteJump || conversationId !== selectedId) {
        return;
      }
      if (where.conversationId !== conversationId) {
        await jumpToMessage({
          conversationId: where.conversationId,
          id: where.messageId,
        });
        return;
      }
    } catch {
      // Not found anywhere Signal can say; look further back here.
    }
  }
  for (let page = 0; !found && nextCursor && page < MAX_QUOTE_PAGES; page++) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await loadMessages({ older: true });
    } catch (error) {
      toast(`Couldn't load older messages (${error.code ?? error.message}).`);
      return;
    }
    if (conversationId !== selectedId || jump !== quoteJump) {
      return;
    }
    found = findQuoted(quote);
  }
  if (!found || !flashMessage(found.id)) {
    toast('Original message not found.');
  }
}

// Scrolls a loaded message into view and highlights it briefly.
function flashMessage(messageId) {
  const li = $('message-list').querySelector(
    `[data-id="${CSS.escape(messageId)}"]`
  );
  if (!li) {
    return false;
  }
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  li.classList.remove('flash');
  // Restart the animation when the same message is picked twice.
  void li.offsetWidth;
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1600);
  return true;
}

// As Signal's quote names an attachment it has no text for.
function quoteLabel(a) {
  const type = a.contentType.split('/')[0];
  if (type === 'audio') {
    return a.isVoiceMessage ? 'Voice message' : 'Audio';
  }
  if (type === 'image') {
    return a.isGif ? 'GIF' : 'Photo';
  }
  if (type === 'video') {
    return 'Video';
  }
  return a.fileName ?? 'File';
}

const QUOTE_THUMB_PX = 48;

// The small square picture on the right of a quote, like Signal's.
function addQuoteThumb(box, src) {
  const img = el('img', 'quote-thumb');
  img.alt = '';
  img.loading = 'lazy';
  img.src = src;
  img.addEventListener('error', () => {
    img.remove();
    box.classList.remove('has-thumb');
  });
  box.classList.add('has-thumb');
  box.append(img);
}

function renderQuote(quote, m) {
  const box = el('span', 'quote');
  const link = m ? privateLinks.byReply.get(m.id) : undefined;
  if (link) {
    box.classList.add('jumps');
    box.title = 'Go to the group message';
    box.addEventListener('click', ev => {
      ev.stopPropagation();
      jumpToMessage({
        conversationId: link.groupConversationId,
        id: link.groupMessageId,
      });
    });
  } else if (quote.sentAt !== null) {
    box.classList.add('jumps');
    box.title = 'Go to message';
    box.addEventListener('click', ev => {
      ev.stopPropagation();
      jumpToQuote(quote, m);
    });
  }
  const author = quote.author ?? authorOf(quote.authorConversationId);
  if (author?.nameColor) {
    box.classList.add(`nc-${author.nameColor}`);
  }
  const a = quote.attachment;
  box.append(
    nameLine(nameOf(quote.authorConversationId), author, 'quote-author'),
    el(
      'span',
      'quote-text',
      quote.text || (a ? quoteLabel(a) : null) || 'Attachment'
    )
  );
  if (a?.hasThumbnail && m) {
    addQuoteThumb(
      box,
      `api/thumbnail?${new URLSearchParams({
        messageId: m.id,
        quote: '1',
        width: String(previewWidth(QUOTE_THUMB_PX)),
      })}`
    );
  }
  if (link) {
    const group = conversations.get(link.groupConversationId);
    box.append(
      el(
        'span',
        'quote-from',
        `Replied privately from ${group ? displayTitle(group) : 'a group'}`
      )
    );
  }
  return box;
}

function renderReactions(m) {
  const counts = new Map();
  for (const r of m.reactions) {
    const entry = counts.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    entry.mine ||= r.fromMe;
    counts.set(r.emoji, entry);
  }
  const box = el('span', 'reactions');
  for (const [emoji, { count, mine }] of counts) {
    const chip = el('button', `reaction${mine ? ' mine' : ''}`);
    chip.type = 'button';
    chip.append(el('span', 'emoji', emoji));
    if (count > 1) {
      chip.append(el('span', 'count', String(count)));
    }
    chip.title = m.reactions
      .filter(r => r.emoji === emoji)
      .map(r => (r.fromMe ? 'You' : nameOf(r.authorConversationId)))
      .join(', ');
    chip.addEventListener('click', e => {
      e.stopPropagation();
      openReactionViewer(m, box, emoji);
    });
    box.append(chip);
  }
  return box;
}

// As Signal's reaction viewer: an All tab and one per emoji, then who
// reacted. Our own row takes the reaction back, as picking it again would.
function openReactionViewer(m, anchor, selected) {
  closePopovers();
  const viewer = $('reaction-viewer');
  const counts = new Map();
  for (const r of m.reactions) {
    counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  }
  const tabs = el('div', 'viewer-tabs');
  const list = el('div', 'viewer-list');
  const show = emoji => {
    for (const tab of tabs.children) {
      tab.classList.toggle('active', tab.dataset.emoji === (emoji ?? ''));
    }
    list.replaceChildren(
      ...m.reactions
        .filter(r => emoji === null || r.emoji === emoji)
        .toSorted((a, b) => Number(b.fromMe) - Number(a.fromMe))
        .map(r => {
          const id = r.authorConversationId;
          const row = el('div', 'viewer-row');
          const who = authorOf(id) ?? { title: nameOf(id) };
          const name = el('span', 'viewer-name', r.fromMe ? 'You' : nameOf(id));
          row.append(avatar(id, who, 36), name, el('span', 'emoji', r.emoji));
          if (r.fromMe && canReact()) {
            row.classList.add('mine');
            name.append(el('span', 'sub', 'Click to remove'));
            row.addEventListener('click', e => {
              e.stopPropagation();
              closePopovers();
              sendReaction(m, r.emoji, true);
            });
          }
          return row;
        })
    );
  };
  const tab = (emoji, label) => {
    const button = el('button', 'viewer-tab');
    button.type = 'button';
    button.dataset.emoji = emoji ?? '';
    button.append(...label);
    button.addEventListener('click', e => {
      e.stopPropagation();
      show(emoji);
    });
    tabs.append(button);
  };
  tab(null, [el('span', '', `All ${m.reactions.length}`)]);
  for (const [emoji, count] of counts) {
    tab(emoji, [el('span', 'emoji', emoji), el('span', '', String(count))]);
  }
  viewer.replaceChildren(tabs, list);
  show(counts.size > 1 ? selected : null);
  placePopover(viewer, anchor);
}

function canReact() {
  return capabilities.includes('messages.react');
}

function canReplyTo(m) {
  return m.kind !== 'deleted' && m.kind !== 'unsupported';
}

function actionButton(name, label, onClick) {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', e => {
    e.stopPropagation();
    onClick(button);
  });
  return button;
}

function renderActions(m) {
  const actions = el('span', 'actions');
  if (canReact() && canReplyTo(m)) {
    actions.append(
      actionButton('react', 'React', button => openReactionPicker(m, button))
    );
  }
  if (canReplyTo(m)) {
    actions.append(actionButton('reply', 'Reply', () => startReply(m)));
  }
  actions.append(
    actionButton('more', 'More actions', button => openMoreMenu(m, button))
  );
  return actions;
}

// --- attachments ---------------------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentParams(m, index, extra = {}) {
  return new URLSearchParams({
    messageId: m.id,
    index: String(index),
    ...extra,
  });
}

function attachmentUrl(m, index, a, extra = {}) {
  return `api/attachment?${attachmentParams(m, index, {
    name: a.fileName ?? 'attachment',
    ...extra,
  })}`;
}

function kindOf(a) {
  const type = a.contentType.split('/')[0];
  if (a.isVoiceMessage || type === 'audio') {
    return 'audio';
  }
  if (type === 'image') {
    return 'image';
  }
  if (type === 'video') {
    return a.isGif ? 'gif' : 'video';
  }
  return 'file';
}

function requestDownload(m) {
  api('api/download', { messageId: m.id }).catch(error =>
    toast(`Couldn't download (${error.code ?? error.message}).`)
  );
}

// The status line on media that is not on this computer yet.
function downloadState(m, a) {
  if (a.state === 'downloading') {
    return el('span', 'media-state', 'Downloading…');
  }
  if (a.state === 'failed') {
    return el('span', 'media-state', "Couldn't download");
  }
  const button = el(
    'button',
    'media-state action',
    `Download · ${formatSize(a.size)}`
  );
  button.type = 'button';
  button.addEventListener('click', e => {
    e.stopPropagation();
    requestDownload(m);
  });
  return button;
}

// Device pixels for an image drawn this many CSS pixels wide, in steps so
// the browser's cache still works after a zoom change.
function previewWidth(cssWidth) {
  const px = cssWidth * Math.max(1, window.devicePixelRatio || 1);
  return Math.min(1600, Math.ceil(px / 160) * 160);
}

function mediaBox(a, multiple) {
  const box = el('span', `media${multiple ? ' tile' : ''}`);
  if (!multiple && a.width && a.height) {
    // Keep the shape before the image arrives, as Signal does.
    const width = Math.min(320, a.width);
    box.style.width = `${width}px`;
    box.style.aspectRatio = `${a.width} / ${Math.max(1, a.height)}`;
  }
  return box;
}

function renderVisual(m, a, index, multiple) {
  const box = mediaBox(a, multiple);
  const kind = kindOf(a);
  if (kind === 'gif' && a.state === 'ready') {
    const video = el('video');
    video.src = attachmentUrl(m, index, a);
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    box.append(video);
    return box;
  }
  if (a.hasThumbnail) {
    const img = el('img');
    img.alt = a.caption ?? '';
    img.loading = 'lazy';
    img.src = `api/thumbnail?${attachmentParams(m, index, {
      width: String(previewWidth(multiple ? 160 : 320)),
    })}`;
    box.append(img);
  } else {
    box.classList.add('placeholder');
  }
  if (kind === 'video' || kind === 'gif') {
    const play = el('span', 'play');
    play.append(icon('play'));
    box.append(play);
  }
  if (a.state !== 'ready') {
    box.append(downloadState(m, a));
    return box;
  }
  box.classList.add('clickable');
  box.addEventListener('click', () => openLightbox(m, index));
  return box;
}

function renderAudio(m, a, index) {
  const box = el('span', 'audio');
  if (a.state === 'ready') {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = attachmentUrl(m, index, a);
    box.append(audio);
  } else {
    box.append(
      el(
        'span',
        'file-name',
        a.isVoiceMessage ? 'Voice message' : (a.fileName ?? 'Audio')
      ),
      downloadState(m, a)
    );
  }
  return box;
}

function renderFile(m, a, index) {
  const row = el(a.state === 'ready' ? 'a' : 'span', 'file');
  const badge = el('span', 'file-icon');
  badge.textContent = (a.fileName?.split('.').pop() ?? '')
    .slice(0, 4)
    .toUpperCase();
  const text = el('span', 'file-text');
  text.append(
    el('span', 'file-name', a.fileName ?? 'File'),
    el('span', 'file-size', formatSize(a.size))
  );
  row.append(badge, text);
  if (a.state === 'ready') {
    row.href = attachmentUrl(m, index, a, { download: '1' });
    row.download = a.fileName ?? 'attachment';
  } else {
    row.append(downloadState(m, a));
  }
  return row;
}

function renderAttachments(m) {
  const box = el('span', 'attachments');
  const visual = [];
  m.attachments.forEach((a, index) => {
    const kind = kindOf(a);
    if (kind === 'image' || kind === 'video' || kind === 'gif') {
      visual.push([a, index]);
    }
  });
  if (visual.length > 0) {
    const grid = el('span', `media-grid${visual.length > 1 ? ' multi' : ''}`);
    for (const [a, index] of visual) {
      grid.append(renderVisual(m, a, index, visual.length > 1));
    }
    box.append(grid);
  }
  m.attachments.forEach((a, index) => {
    const kind = kindOf(a);
    if (kind === 'audio') {
      box.append(renderAudio(m, a, index));
    } else if (kind === 'file') {
      box.append(renderFile(m, a, index));
    }
  });
  const captions = m.attachments.map(a => a.caption).filter(Boolean);
  if (captions.length > 0 && !m.body) {
    box.append(el('span', 'body', captions.join('\n')));
  }
  return box;
}

function renderSticker(m) {
  const box = el('span', 'sticker');
  if (m.sticker?.ready) {
    const img = el('img');
    img.alt = m.sticker.emoji ?? 'Sticker';
    img.src = `api/attachment?${new URLSearchParams({ messageId: m.id, sticker: '1' })}`;
    box.append(img);
  } else {
    box.append(el('span', 'body note', `Sticker ${m.sticker?.emoji ?? ''}`));
    const button = el('button', 'media-state action', 'Download');
    button.type = 'button';
    button.addEventListener('click', () => requestDownload(m));
    box.append(button);
  }
  return box;
}

// Full-size view of a message's photos and videos, like Signal's: arrows,
// arrow keys or a swipe move between them, the strip below jumps to one.
let lightbox = null;

function lightboxItems(m) {
  return m.attachments.flatMap((a, index) =>
    ['image', 'video', 'gif'].includes(kindOf(a)) && a.state === 'ready'
      ? [index]
      : []
  );
}

function openLightbox(m, index) {
  const items = lightboxItems(m);
  lightbox = {
    m,
    items,
    pos: Math.max(0, items.indexOf(index)),
    gallery: null,
  };
  $('lightbox-goto').hidden = true;
  renderLightboxStrip();
  showLightboxItem();
  $('lightbox').hidden = false;
}

function showLightboxItem() {
  const { m, items, pos } = lightbox;
  const index = items[pos];
  const a = m.attachments[index];
  let content;
  if (kindOf(a) === 'image') {
    content = el('img');
    content.alt = a.caption ?? '';
  } else {
    content = el('video');
    content.controls = true;
    content.autoplay = true;
    content.loop = a.isGif;
    content.playsInline = true;
  }
  content.src = attachmentUrl(m, index, a);
  // Replacing the stage drops (and so stops) a playing video.
  $('lightbox-stage').replaceChildren(content);
  $('lightbox-caption').textContent = a.caption ?? '';
  $('lightbox-save').href = attachmentUrl(m, index, a, { download: '1' });
  $('lightbox-save').download = a.fileName ?? 'attachment';
  const several = items.length > 1;
  $('lightbox-count').textContent = several
    ? `${pos + 1} of ${items.length}`
    : '';
  $('lightbox').classList.toggle('several', several);
  // Hidden but keeping its place, so the photo stays centred.
  $('lightbox-prev').classList.toggle('off', pos === 0);
  $('lightbox-next').classList.toggle('off', pos === items.length - 1);
  for (const [i, thumb] of [
    ...$('lightbox-strip').querySelectorAll('button'),
  ].entries()) {
    thumb.classList.toggle('current', i === pos);
    if (i === pos) {
      thumb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // The neighbours' photos load ahead, so stepping is instant.
  for (const near of [pos - 1, pos + 1]) {
    const i = items[near];
    if (i !== undefined && kindOf(m.attachments[i]) === 'image') {
      new Image().src = attachmentUrl(m, i, m.attachments[i]);
    }
  }
}

function renderLightboxStrip() {
  const { m, items } = lightbox;
  const strip = $('lightbox-strip');
  strip.hidden = items.length < 2;
  strip.replaceChildren(
    ...(items.length < 2 ? [] : items).map((index, pos) => {
      const a = m.attachments[index];
      const thumb = el('button', 'lightbox-thumb');
      thumb.type = 'button';
      thumb.setAttribute('aria-label', `${pos + 1} of ${items.length}`);
      if (a.hasThumbnail) {
        const img = el('img');
        img.alt = '';
        img.src = `api/thumbnail?${attachmentParams(m, index, {
          width: String(previewWidth(56)),
        })}`;
        thumb.append(img);
      }
      if (kindOf(a) !== 'image') {
        thumb.append(icon('play'));
      }
      thumb.addEventListener('click', () => stepLightbox(pos - lightbox.pos));
      return thumb;
    })
  );
}

function stepLightbox(delta) {
  if (!lightbox) {
    return;
  }
  const pos = lightbox.pos + delta;
  if (pos < 0 || pos >= lightbox.items.length || delta === 0) {
    return;
  }
  lightbox.pos = pos;
  showLightboxItem();
}

function closeLightbox() {
  lightbox = null;
  $('lightbox').hidden = true;
  $('lightbox-stage').replaceChildren();
  $('lightbox-strip').replaceChildren();
}

// --- all media (decision F31) ---------------------------------------------------

// As Signal's "All media": a chat's photos and videos, voice notes and
// audio, links and files, newest first, by month. A photo opens in the
// viewer, which steps only through that message's (Mike's preference).
const GALLERY_TABS = [
  ['media', 'Media'],
  ['audio', 'Audio'],
  ['links', 'Links'],
  ['files', 'Files'],
];
let gallery = null;

function openGallery(conversationId) {
  const c = conversations.get(conversationId);
  if (!c) {
    return;
  }
  closePopovers();
  closeDetails();
  gallery = { conversationId, kind: 'media' };
  $('gallery-title').textContent = `All media · ${displayTitle(c)}`;
  $('gallery').hidden = false;
  showGalleryTab('media');
}

function closeGallery() {
  gallery = null;
  $('gallery').hidden = true;
  $('gallery-body').replaceChildren();
}

function showGalleryTab(kind) {
  gallery = {
    conversationId: gallery.conversationId,
    kind,
    items: [],
    messages: new Map(),
    cursor: null,
    done: false,
    loading: false,
    seq: (gallery.seq ?? 0) + 1,
  };
  for (const tab of $('gallery-tabs').querySelectorAll('button')) {
    tab.classList.toggle('active', tab.dataset.kind === kind);
  }
  $('gallery-body').replaceChildren();
  $('gallery-body').scrollTop = 0;
  loadGalleryPage();
}

async function loadGalleryPage() {
  const g = gallery;
  if (!g || g.loading || g.done) {
    return;
  }
  g.loading = true;
  const params = new URLSearchParams({
    conversationId: g.conversationId,
    kind: g.kind,
    ...(g.cursor ? { cursor: g.cursor } : {}),
  });
  try {
    const page = await api(`api/media?${params}`);
    if (gallery?.seq !== g.seq) {
      return;
    }
    for (const m of page.messages) {
      g.messages.set(m.id, m);
    }
    g.items.push(...page.items);
    g.cursor = page.nextCursor;
    g.done = !page.nextCursor;
  } catch (error) {
    g.done = true;
    toast(`Couldn't load media (${error.code ?? error.message}).`);
  } finally {
    g.loading = false;
  }
  renderGallery();
  // Fill the window before waiting for a scroll.
  const body = $('gallery-body');
  if (!g.done && body.scrollHeight <= body.clientHeight + 200) {
    loadGalleryPage();
  }
}

function galleryMonth(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth()
  ) {
    return 'This month';
  }
  return d.toLocaleDateString([], {
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function galleryShowInChat(m) {
  const button = el('button', 'icon-button gallery-goto');
  button.type = 'button';
  button.title = 'Show in chat';
  button.setAttribute('aria-label', 'Show in chat');
  button.append(icon('goto'));
  button.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    closeGallery();
    jumpToMessage(m);
  });
  return button;
}

function galleryRow(m, kind, index) {
  const row = el('div', `gallery-row gallery-${kind}`);
  const meta = el(
    'div',
    'gallery-meta sub',
    `${m.direction === 'outgoing' ? 'You' : nameOf(m.authorConversationId)} · ${formatTime(m.sentAt)}`
  );
  if (kind === 'audio') {
    const a = m.attachments[index];
    row.append(
      el(
        'div',
        'gallery-row-name',
        a.isVoiceMessage ? 'Voice message' : (a.fileName ?? 'Audio')
      ),
      renderAudio(m, a, index),
      meta
    );
  } else if (kind === 'files') {
    row.append(renderFile(m, m.attachments[index], index), meta);
  } else {
    const card = renderLinkPreview(m, m.previews[index], index);
    card.append(el('span', 'gallery-url', m.previews[index].url));
    row.append(card, meta);
  }
  row.append(galleryShowInChat(m));
  return row;
}

function renderGallery() {
  const g = gallery;
  const body = $('gallery-body');
  const scroll = body.scrollTop;
  const sections = [];
  let current = null;
  for (const item of g.items) {
    const m = g.messages.get(item.messageId);
    if (!m) {
      continue;
    }
    const month = galleryMonth(m.sentAt);
    if (current?.month !== month) {
      const list = el(
        'div',
        g.kind === 'media' ? 'gallery-grid' : 'gallery-list'
      );
      current = { month, list };
      sections.push(el('h3', 'gallery-month', month), list);
    }
    if (g.kind === 'media') {
      const tile = renderVisual(m, m.attachments[item.index], item.index, true);
      tile.classList.add('gallery-tile');
      tile.addEventListener('click', () => {
        if (lightbox) {
          lightbox.gallery = m;
          $('lightbox-goto').hidden = false;
        }
      });
      current.list.append(tile);
    } else {
      current.list.append(galleryRow(m, g.kind, item.index));
    }
  }
  if (sections.length === 0) {
    sections.push(
      el(
        'p',
        'gallery-empty sub',
        g.done
          ? {
              media: 'No photos or videos in this chat',
              audio: 'No audio in this chat',
              links: 'No links in this chat',
              files: 'No files in this chat',
            }[g.kind]
          : 'Loading…'
      )
    );
  }
  body.replaceChildren(...sections);
  body.scrollTop = scroll;
}

// --- message text: mentions, formatting, links ----------------------------------

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

function appendLinkified(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) {
      parent.append(text.slice(last, match.index));
    }
    const link = el('a', 'link', match[0]);
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parent.append(text.slice(last));
  }
}

const STYLE_CLASS = {
  bold: 'f-bold',
  italic: 'f-italic',
  strikethrough: 'f-strike',
  monospace: 'f-mono',
  spoiler: 'f-spoiler',
  // Search matches, in snippets.
  highlight: 'f-highlight',
};

// Splits the body at every range edge and styles each piece, as Signal's
// own renderer does.
function renderBody(m) {
  const body = el('span', 'body');
  if (isJumboBody(m)) {
    body.classList.add('jumbo-body');
  }
  const text = m.body ?? '';
  const mentions = m.mentions ?? [];
  const formatting = m.formatting ?? [];
  const edges = new Set([0, text.length]);
  for (const r of [...mentions, ...formatting]) {
    edges.add(Math.max(0, Math.min(text.length, r.start)));
    edges.add(Math.max(0, Math.min(text.length, r.start + r.length)));
  }
  const points = [...edges].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const styles = formatting
      .filter(r => r.start <= start && r.start + r.length >= end)
      .map(r => STYLE_CLASS[r.style])
      .filter(Boolean);
    const mention = mentions.find(
      r => r.start <= start && r.start + r.length >= end
    );
    let node = body;
    if (styles.length > 0) {
      node = el('span', styles.join(' '));
      if (styles.includes('f-spoiler')) {
        node.title = 'Spoiler: click to reveal';
        node.addEventListener('click', e => {
          e.stopPropagation();
          node.classList.add('revealed');
        });
      }
      body.append(node);
    }
    if (mention) {
      // One mention may span several pieces; write it once.
      if (start === mention.start) {
        node.append(el('span', 'mention', `@${mention.title ?? 'Someone'}`));
      }
    } else if (styles.includes('f-mono')) {
      node.append(text.slice(start, end));
    } else {
      appendLinkified(node, text.slice(start, end));
    }
  }
  return body;
}

function isJumboBody(m) {
  return (
    m.kind === 'text' &&
    !m.quote &&
    m.attachments.length === 0 &&
    (m.mentions ?? []).length === 0 &&
    isJumbo(m.body)
  );
}

function renderLinkPreview(m, p, index) {
  const card = el('a', 'link-preview');
  card.href = p.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  if (p.hasImage) {
    const img = el('img', 'link-preview-image');
    img.alt = '';
    img.loading = 'lazy';
    img.src = `api/thumbnail?${new URLSearchParams({
      messageId: m.id,
      preview: String(index),
      width: String(previewWidth(360)),
    })}`;
    card.append(img);
  }
  const text = el('span', 'link-preview-text');
  if (p.title) {
    text.append(el('span', 'link-preview-title', p.title));
  }
  if (p.description) {
    text.append(el('span', 'link-preview-description', p.description));
  }
  let domain = p.domain;
  if (!domain) {
    try {
      domain = new URL(p.url).hostname;
    } catch {
      domain = '';
    }
  }
  text.append(el('span', 'link-preview-domain', domain));
  card.append(text);
  return card;
}

// prev/next: the neighboring messages, to group runs by the same author.
function renderMessage(m, prev, next) {
  const outgoing = m.direction === 'outgoing';
  const conversation = conversations.get(m.conversationId);
  const isGroupChat = conversation?.type === 'group';
  const sameAuthor = other =>
    other &&
    other.direction === m.direction &&
    other.authorConversationId === m.authorConversationId &&
    Math.abs(other.sentAt - m.sentAt) < 10 * 60_000;
  const firstOfRun = !sameAuthor(prev);
  const lastOfRun = !sameAuthor(next);

  const li = el('li', `msg ${outgoing ? 'out' : 'in'}`);
  if (!lastOfRun) {
    li.classList.add('run');
  }
  li.dataset.id = m.id;

  if (!outgoing && isGroupChat) {
    li.classList.add('with-avatar');
    if (lastOfRun && m.authorConversationId) {
      const who = authorOf(m.authorConversationId) ?? { title: 'Someone' };
      const face = avatar(m.authorConversationId, who, 28);
      face.classList.add('clickable');
      face.title = `About ${who.title}`;
      face.addEventListener('click', ev => {
        ev.stopPropagation();
        openPerson(m.authorConversationId, m.author ?? who);
      });
      li.append(face);
    } else {
      li.append(el('span', 'avatar-spacer'));
    }
  }

  const column = el('span', 'column');
  const jumbo =
    m.kind === 'text' &&
    !m.quote &&
    m.attachments.length === 0 &&
    isJumbo(m.body);
  const bubble = el('span', `bubble${jumbo ? ' jumbo' : ''}`);

  if (!outgoing && isGroupChat && firstOfRun) {
    const name = nameLine(nameOf(m.authorConversationId), m.author, 'author');
    if (m.authorConversationId) {
      name.classList.add('clickable');
      name.addEventListener('click', ev => {
        ev.stopPropagation();
        openPerson(m.authorConversationId, m.author);
      });
    }
    bubble.append(name);
  }
  if (m.quote) {
    bubble.append(renderQuote(m.quote, m));
  }
  if (m.kind === 'text' && m.attachments.length > 0) {
    bubble.classList.add('has-media');
    bubble.append(renderAttachments(m));
  }
  if (m.kind === 'poll' && m.poll) {
    bubble.append(renderPoll(m));
  } else if (m.kind === 'sticker') {
    bubble.classList.add('sticker-bubble');
    bubble.append(renderSticker(m));
  } else if (m.kind !== 'text') {
    bubble.append(el('span', 'body note', summarize(m)));
  } else if (m.body) {
    if (m.previews?.length > 0) {
      bubble.classList.add('has-media');
      bubble.append(...m.previews.map((p, i) => renderLinkPreview(m, p, i)));
    }
    const body = renderBody(m);
    if (m.bodyTruncated) {
      body.append(' …');
    }
    bubble.append(body);
  }

  const meta = el('span', 'meta');
  const bits = [formatTime(m.sentAt)];
  if (m.edited) {
    bits.push('Edited');
  }
  // Problems keep their words too; the checkmarks speak for themselves.
  if (['failed', 'partiallySent', 'paused'].includes(m.sendStatus)) {
    bits.push(STATUS_TEXT[m.sendStatus]);
  }
  meta.textContent = bits.join(' · ');
  if (m.sendStatus) {
    meta.append(statusIcon(m.sendStatus));
  }
  bubble.append(meta);

  const line = el('span', 'bubble-line');
  line.append(bubble, renderActions(m));
  column.append(line);
  if (m.reactions.length > 0) {
    column.append(renderReactions(m));
  }
  const privateLink = renderPrivateLink(m);
  if (privateLink) {
    column.append(privateLink);
  }
  li.append(column);
  return li;
}

function sortedMessages() {
  return [...messages.values()].sort((a, b) => a.sentAt - b.sentAt);
}

// Rendered messages are kept and reused while unchanged, and the list is
// patched in place, so playing media and loaded images are left alone.
const messageCache = new Map();

function cachedMessage(m, prev, next) {
  const key = JSON.stringify([
    m,
    prev?.authorConversationId,
    prev?.direction,
    prev?.sentAt,
    next?.authorConversationId,
    next?.direction,
    next?.sentAt,
    capabilities,
    formatTime(m.sentAt),
  ]);
  const cached = messageCache.get(m.id);
  if (cached && cached.key === key) {
    return cached.li;
  }
  const li = renderMessage(m, prev, next);
  messageCache.set(m.id, { key, li });
  return li;
}

function patchChildren(parent, wanted) {
  wanted.forEach((node, i) => {
    if (parent.children[i] !== node) {
      parent.insertBefore(node, parent.children[i] ?? null);
    }
  });
  while (parent.children.length > wanted.length) {
    parent.lastElementChild.remove();
  }
}

function unreadLineNode() {
  if (!unreadLineEl) {
    const { count } = unreadLine;
    unreadLineEl = el('li', 'unread-line');
    unreadLineEl.setAttribute('role', 'separator');
    unreadLineEl.append(
      el(
        'span',
        '',
        count === 1 ? '1 Unread Message' : `${count} Unread Messages`
      )
    );
  }
  return unreadLineEl;
}

function nearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

// Signal's button for going back down to the newest message, with the
// chat's unread count.
function renderToNewest() {
  const c = conversations.get(selectedId);
  const button = $('to-newest');
  button.hidden =
    !c || $('messages').hidden || (newerCursor === null && nearBottom());
  // Just above whatever is under the messages (composer, request bar).
  const box = $('messages');
  button.style.bottom = `${
    $('chat').clientHeight - (box.offsetTop + box.offsetHeight) + 16
  }px`;
  const unread = c?.unreadCount ?? 0;
  const badge = button.querySelector('.badge');
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
}

async function goToNewest() {
  if (newerCursor !== null) {
    await showLatest();
  } else {
    const box = $('messages');
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }
}

// Opening a chat with unread messages: load back to the oldest unread one
// and put Signal's line above it.
async function placeUnreadLine(count) {
  const conversationId = selectedId;
  const unreadLoaded = () =>
    sortedMessages().filter(m => m.direction === 'incoming' && m.read === false)
      .length;
  for (
    let page = 0;
    unreadLoaded() < count && nextCursor && page < 20;
    page++
  ) {
    // oxlint-disable-next-line no-await-in-loop
    await loadMessages({ older: true });
    if (conversationId !== selectedId) {
      return;
    }
  }
  const oldest = sortedMessages().find(
    m => m.direction === 'incoming' && m.read === false
  );
  unreadLine = oldest ? { messageId: oldest.id, count } : null;
  unreadLineEl = null;
}

function renderMessages({ keepBottom = true, appended = false } = {}) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousHeight = box.scrollHeight;
  const list = sortedMessages();
  patchChildren(
    $('message-list'),
    list.flatMap((m, i) => {
      const li = cachedMessage(m, list[i - 1], list[i + 1]);
      return m.id === unreadLine?.messageId ? [unreadLineNode(), li] : [li];
    })
  );
  for (const id of messageCache.keys()) {
    if (!messages.has(id)) {
      messageCache.delete(id);
    }
  }
  $('older').hidden = !nextCursor;
  $('newer').hidden = newerCursor === null;
  renderToNewest();
  if (appended) {
    // Newer messages went in below; the view stays where it is.
  } else if (keepBottom && atBottom) {
    box.scrollTop = box.scrollHeight;
  } else if (!keepBottom) {
    // Loading older messages: keep the same message in view.
    box.scrollTop += box.scrollHeight - previousHeight;
  }
}

function scheduleExpiry(m) {
  if (m.expiresAt === null || expiryTimers.has(m.id)) {
    return;
  }
  const delay = Math.max(0, m.expiresAt - Date.now());
  expiryTimers.set(
    m.id,
    setTimeout(
      () => {
        expiryTimers.delete(m.id);
        if (messages.delete(m.id)) {
          renderMessages();
        }
      },
      Math.min(delay, 2 ** 31 - 1)
    )
  );
}

function putMessage(m) {
  rememberAuthors(m);
  if (m.expiresAt !== null && m.expiresAt <= Date.now()) {
    messages.delete(m.id);
    return;
  }
  messages.set(m.id, m);
  scheduleExpiry(m);
}

function clearExpiryTimers() {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
}

async function loadNewer() {
  const conversationId = selectedId;
  if (newerCursor === null || loadingNewer) {
    return;
  }
  loadingNewer = true;
  let page;
  try {
    page = await api(
      `api/messages?${new URLSearchParams({
        conversationId,
        cursor: newerCursor,
        newer: '1',
      })}`
    );
  } catch (error) {
    toast(`Couldn't load newer messages (${error.code ?? error.message}).`);
    return;
  } finally {
    loadingNewer = false;
  }
  if (conversationId !== selectedId) {
    return;
  }
  for (const m of page.messages) {
    putMessage(m);
  }
  newerCursor = page.nextCursor;
  renderMessages({ appended: true });
  maybeMarkRead();
}

async function loadMessages({ older = false } = {}) {
  const conversationId = selectedId;
  const params = new URLSearchParams({ conversationId });
  if (older && nextCursor) {
    params.set('cursor', nextCursor);
  }
  const page = await api(`api/messages?${params}`);
  if (conversationId !== selectedId) {
    return;
  }
  for (const m of page.messages) {
    putMessage(m);
  }
  nextCursor = page.nextCursor;
  renderMessages({ keepBottom: !older });
}

// --- chat menu (Signal's header menu and the chat list's context menu) ---

const MUTE_CHOICES = [
  [60 * 60_000, 'Mute for one hour'],
  [8 * 60 * 60_000, 'Mute for eight hours'],
  [24 * 60 * 60_000, 'Mute for one day'],
  [7 * 24 * 60 * 60_000, 'Mute for one week'],
  [null, 'Mute always'],
];

const TIMER_CHOICES = [
  [0, 'Off'],
  [30, '30 seconds'],
  [5 * 60, '5 minutes'],
  [60 * 60, '1 hour'],
  [8 * 60 * 60, '8 hours'],
  [24 * 60 * 60, '1 day'],
  [7 * 24 * 60 * 60, '1 week'],
  [4 * 7 * 24 * 60 * 60, '4 weeks'],
];

function canManageChats() {
  return capabilities.includes('conversations.manage');
}

async function changeConversation(conversationId, change) {
  try {
    await api('api/conversation', { conversationId, change });
  } catch (error) {
    toast(
      change.action === 'pin' && error.code === 'PRECONDITION_FAILED'
        ? 'You can only pin up to 4 chats.'
        : `Not changed (${error.code ?? error.message}).`
    );
    return false;
  }
  return true;
}

function mutedUntilText(c) {
  if (!c.mutedUntil) {
    return null;
  }
  // Signal stores "always" as a far-off date.
  if (c.mutedUntil > Date.now() + 10 * 365 * 24 * 3600_000) {
    return 'Muted always';
  }
  const d = new Date(c.mutedUntil);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Muted until ${
    sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString([], {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })
  }`;
}

function timerLabel(seconds) {
  const known = TIMER_CHOICES.find(([v]) => v === seconds);
  if (known) {
    return known[1];
  }
  if (seconds % 86400 === 0) {
    return `${seconds / 86400} days`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} hours`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} minutes`;
  }
  return `${seconds} seconds`;
}

// page: null for the main menu, or 'mute' / 'timer'.
function openChatMenu(conversationId, anchor, page = null) {
  const c = conversations.get(conversationId);
  if (!c) {
    return;
  }
  closePopovers();
  const menu = $('more-menu');
  const items = [];
  const add = (iconName, label, action, { keepOpen = false } = {}) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(
      iconName ? icon(iconName) : el('span', 'icon'),
      el('span', '', label)
    );
    item.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!keepOpen) {
        closePopovers();
      }
      action();
    });
    items.push(item);
  };
  const set = change => changeConversation(c.id, change);

  if (!canManageChats()) {
    items.push(
      el(
        'span',
        'menu-empty',
        'Allow this page to manage chats in Signal to use this menu.'
      )
    );
  } else if (page === 'mute') {
    add('back', 'Back', () => openChatMenu(conversationId, anchor), {
      keepOpen: true,
    });
    items.push(el('div', 'menu-separator'));
    if (c.muted) {
      add('bell', 'Unmute', () => set({ action: 'unmute' }));
    }
    for (const [durationMs, label] of MUTE_CHOICES) {
      add(null, label, () => set({ action: 'mute', durationMs }));
    }
  } else if (page === 'timer') {
    add('back', 'Back', () => openChatMenu(conversationId, anchor), {
      keepOpen: true,
    });
    items.push(el('div', 'menu-separator'));
    const choices = TIMER_CHOICES.some(([v]) => v === c.disappearingSeconds)
      ? TIMER_CHOICES
      : [
          ...TIMER_CHOICES,
          [c.disappearingSeconds, timerLabel(c.disappearingSeconds)],
        ];
    for (const [seconds, label] of choices) {
      add(seconds === c.disappearingSeconds ? 'check' : null, label, () =>
        set({ action: 'disappearingMessages', seconds })
      );
    }
  } else {
    const blocked = c.blocked;
    if ($('details').hidden) {
      add('note', c.type === 'group' ? 'Group details' : 'About', () =>
        openDetails(c.id)
      );
      add('search', 'Search in chat', () => startChatSearch(c.id));
      add('media', 'All media', () => openGallery(c.id));
      items.push(el('div', 'menu-separator'));
    }
    if (!blocked && !c.messageRequestPending) {
      if (!c.noteToSelf && c.canChangeTimer) {
        add(
          'timer',
          `Disappearing messages: ${timerLabel(c.disappearingSeconds)}`,
          () => openChatMenu(conversationId, anchor, 'timer'),
          { keepOpen: true }
        );
      }
      add(
        'bell',
        c.muted ? (mutedUntilText(c) ?? 'Muted') : 'Mute notifications',
        () => openChatMenu(conversationId, anchor, 'mute'),
        { keepOpen: true }
      );
      if (!c.archived) {
        add(
          c.pinned ? 'unpin' : 'pin',
          c.pinned ? 'Unpin chat' : 'Pin chat',
          () => set({ action: 'pin', value: !c.pinned })
        );
      }
      if (!isUnread(c)) {
        add('unread', 'Mark as unread', () => {
          set({ action: 'markUnread' });
          if (c.id === selectedId) {
            // Signal leaves the chat when you mark it unread.
            closeConversation();
          }
        });
      }
      add('archive', c.archived ? 'Unarchive' : 'Archive', () => {
        set({ action: 'archive', value: !c.archived });
        if (!c.archived && c.id === selectedId) {
          closeConversation();
        }
      });
      items.push(el('div', 'menu-separator'));
    }
    if (c.messageRequestPending && !blocked) {
      add('check', 'Accept', () => set({ action: 'accept' }));
    }
    if (!c.noteToSelf) {
      add('block', blocked ? 'Unblock' : 'Block', () =>
        confirmBlock(c, !blocked)
      );
    }
    add('trash', 'Delete chat', () => confirmDelete(c));
  }
  menu.replaceChildren(...items);
  placePopover(menu, anchor);
}

function confirmBlock(c, block) {
  const group = c.type === 'group';
  const text = block
    ? group
      ? `Block and leave ${displayTitle(c)}? You will no longer receive messages or updates from this group and members won't be able to add you to this group again.`
      : `Block ${displayTitle(c)}? Blocked people won't be able to call you or send you messages.`
    : group
      ? `Unblock ${displayTitle(c)}? Group members will be able to add you to this group again.`
      : `Unblock ${displayTitle(c)}? You will be able to message and call each other.`;
  if (confirm(text)) {
    changeConversation(c.id, { action: block ? 'block' : 'accept' });
  }
}

function confirmDelete(c) {
  const text =
    c.type === 'group'
      ? 'Delete chat? All messages in this chat will be deleted from all your devices. You will still be a member of this group.'
      : 'Delete chat? All messages in this chat will be deleted from all your devices.';
  if (!confirm(text)) {
    return;
  }
  changeConversation(c.id, { action: 'delete' }).then(ok => {
    if (ok && c.id === selectedId) {
      closeConversation();
    }
  });
}

// Back to no chat open, as Signal after archiving or deleting one.
function closeConversation() {
  if (recording) {
    cancelRecording();
  }
  selectedId = null;
  messages = new Map();
  nextCursor = null;
  newerCursor = null;
  unreadLine = null;
  unreadLineEl = null;
  closePopovers();
  cancelReply();
  $('chat-head').hidden = true;
  $('to-newest').hidden = true;
  $('messages').hidden = true;
  $('composer').hidden = true;
  $('request-bar').hidden = true;
  $('empty').hidden = false;
  $('message-list').replaceChildren();
  renderConversations();
  renderTitle();
}

// Signal's bar under a message request or blocked chat.
function renderRequestBar() {
  const bar = $('request-bar');
  const c = conversations.get(selectedId);
  if (!c || c.noteToSelf || !(c.blocked || c.messageRequestPending)) {
    bar.hidden = true;
    $('composer').hidden = !c;
    return;
  }
  // As Signal: the bar replaces the composer until the request is answered.
  $('composer').hidden = true;
  const button = (label, cls, action) => {
    const b = el('button', `request-button ${cls}`, label);
    b.type = 'button';
    b.disabled = !canManageChats();
    b.addEventListener('click', action);
    return b;
  };
  const text = c.blocked
    ? c.type === 'group'
      ? 'You blocked this group.'
      : `You blocked ${displayTitle(c)}.`
    : c.type === 'group'
      ? `Do you want to join this group? They won't know you've seen their messages until you accept.`
      : `Let ${displayTitle(c)} message you and share your name and photo with them? They won't know you've seen their messages until you accept.`;
  const actions = el('div', 'request-actions');
  if (c.blocked) {
    actions.append(
      button('Delete', '', () => confirmDelete(c)),
      button('Unblock', 'primary', () => confirmBlock(c, false))
    );
  } else {
    actions.append(
      button('Block', '', () => confirmBlock(c, true)),
      button('Delete', '', () => confirmDelete(c)),
      button('Accept', 'primary', () =>
        changeConversation(c.id, { action: 'accept' })
      )
    );
  }
  bar.replaceChildren(el('p', 'request-text', text), actions);
  bar.hidden = false;
}

// --- reply privately links (decision F23) ----------------------------------

function addPrivateLink(link) {
  privateLinks.byGroupMessage.set(link.groupMessageId, link);
  privateLinks.byReply.set(link.replyMessageId, link);
}

async function loadPrivateLinks(conversationId) {
  try {
    const { links } = await api(
      `api/privateReplies?${new URLSearchParams({ conversationId })}`
    );
    if (conversationId === selectedId) {
      links.forEach(addPrivateLink);
    }
  } catch {
    // Without links the replies still show, as in Signal.
  }
}

// Under a group message you answered privately: a link to that reply.
function renderPrivateLink(m) {
  const link = privateLinks.byGroupMessage.get(m.id);
  if (!link) {
    return null;
  }
  const b = el('button', 'private-link', 'You replied privately');
  b.type = 'button';
  b.addEventListener('click', ev => {
    ev.stopPropagation();
    jumpToMessage({
      conversationId: link.dmConversationId,
      id: link.replyMessageId,
    });
  });
  return b;
}

// --- chat details (Signal's chat details and About pages) ---

let detailsFor = null;
// The details last shown, and whether the group's edit form is open.
let detailsData = null;
let detailsEditing = false;

function detailRow(iconName, label, sub) {
  const row = el('div', 'detail-row');
  row.append(iconName ? icon(iconName) : el('span', 'icon'));
  const text = el('div', 'detail-text');
  text.append(el('div', 'detail-label', label));
  if (sub) {
    text.append(el('div', 'detail-sub', sub));
  }
  row.append(text);
  return row;
}

// People opened from a group (their photo or name) who have no chat in the
// list yet: id -> a stand-in chat for the details dialog.
const people = new Map();

// As Signal's contact card from a group: their About, and Message.
function openPerson(conversationId, author) {
  if (!conversations.has(conversationId)) {
    people.set(conversationId, {
      id: conversationId,
      type: 'direct',
      title: author?.title ?? 'Someone',
      avatarColor: author?.avatarColor ?? null,
      avatarVersion: author?.avatarVersion ?? null,
    });
  }
  openDetails(conversationId);
}

async function openDetails(conversationId, { refresh = false } = {}) {
  const c = conversations.get(conversationId) ?? people.get(conversationId);
  if (!c) {
    return;
  }
  closePopovers();
  if (refresh && (detailsFor !== conversationId || $('details').hidden)) {
    return;
  }
  if (!refresh) {
    detailsEditing = false;
  }
  detailsFor = conversationId;
  $('details-title').textContent =
    c.type === 'group'
      ? 'Group details'
      : c.noteToSelf
        ? 'Note to Self'
        : 'About';
  const body = $('details-body');
  if (!refresh) {
    body.replaceChildren(el('p', 'setting-note', 'Loading…'));
  }
  $('details').hidden = false;
  if (!capabilities.includes('contacts.read')) {
    renderDetails(c, null);
    return;
  }
  try {
    const { details } = await api(
      `api/details?${new URLSearchParams({ conversationId })}`
    );
    if (detailsFor === conversationId) {
      renderDetails(c, details);
    }
  } catch (error) {
    if (detailsFor === conversationId) {
      body.replaceChildren(
        el(
          'p',
          'setting-note',
          `Couldn't load details (${error.code ?? error.message}).`
        )
      );
    }
  }
}

function renderDetails(c, d) {
  detailsData = d;
  const body = $('details-body');
  if (d?.type === 'group' && detailsEditing) {
    body.replaceChildren(groupEditForm(c, d));
    return;
  }
  const scroll = body.scrollTop;
  const head = el('div', 'details-head');
  head.append(
    conversationAvatar(c, 80),
    el('h2', 'details-name', displayTitle(c))
  );
  const rows = [];
  if (!d) {
    rows.push(
      el(
        'p',
        'setting-note',
        'Allow this page to see chat details in Signal to show them here.'
      )
    );
  } else if (d.type === 'direct') {
    if (d.nickname) {
      rows.push(detailRow('note', d.nickname, 'Nickname'));
    }
    if (d.profileName && d.profileName !== displayTitle(c)) {
      rows.push(detailRow('note', d.profileName, 'Profile name'));
    }
    if (d.about) {
      rows.push(detailRow('edit', d.about));
    }
    if (d.verified) {
      rows.push(detailRow('check', 'Verified'));
    }
    if (d.systemContact) {
      rows.push(detailRow('group', 'In your system contacts'));
    }
    if (d.phoneNumber) {
      rows.push(detailRow('note', d.phoneNumber, 'Phone number'));
    }
    if (d.username) {
      rows.push(detailRow('note', d.username, 'Username'));
    }
    if (d.sharedGroups.length > 0) {
      const names = d.sharedGroups.slice(0, 3).join(', ');
      const more = d.sharedGroups.length - 3;
      rows.push(
        detailRow(
          'group',
          more > 0
            ? `Member of ${names} and ${more} more`
            : `Member of ${names}`
        )
      );
    } else if (!c.noteToSelf) {
      rows.push(detailRow('group', 'No groups in common'));
    }
    if (d.note) {
      rows.push(detailRow('note', d.note, 'Note'));
    }
  } else {
    rows.push(...groupDetailRows(c, d));
  }
  if (c.type === 'direct' && !c.noteToSelf && c.id !== selectedId) {
    const message = el('button', 'setting-button primary', 'Message');
    message.type = 'button';
    message.addEventListener('click', () => {
      closeDetails();
      openContact(c.id);
    });
    rows.push(el('div', 'details-actions'));
    rows.at(-1).append(message);
  }
  if (conversations.has(c.id)) {
    const media = detailRow('media', 'All media');
    media.classList.add('clickable');
    media.addEventListener('click', () => openGallery(c.id));
    rows.push(media);
  }
  if (conversations.has(c.id) && (!c.noteToSelf || canManageChats())) {
    const options = el('button', 'setting-button', 'Chat options');
    options.type = 'button';
    options.addEventListener('click', ev => {
      ev.stopPropagation();
      openChatMenu(c.id, options);
    });
    if (!rows.at(-1)?.classList.contains('details-actions')) {
      rows.push(el('div', 'details-actions'));
    }
    rows.at(-1).append(options);
    if (d?.type === 'group' && d.members.some(m => m.me)) {
      const leave = el('button', 'setting-button danger', 'Leave group');
      leave.type = 'button';
      leave.addEventListener('click', () => confirmLeave(c, d));
      rows.at(-1).append(leave);
    }
  }
  body.replaceChildren(head, ...rows);
  body.scrollTop = scroll;
}

// --- group management (Signal's group details page) -------------------------

function canManageGroups() {
  return capabilities.includes('groups.manage');
}

const GROUP_ERRORS = {
  PERMISSION_DENIED: 'Only admins can do that.',
  NOT_FOUND: "That person isn't in this group anymore.",
};

async function changeGroup(conversationId, change, { done } = {}) {
  try {
    await api('api/group', { conversationId, change });
  } catch (error) {
    toast(
      GROUP_ERRORS[error.code] ??
        (error.code === 'PRECONDITION_FAILED' && change.action === 'leave'
          ? 'Make someone else an admin before you leave.'
          : `Not changed (${error.code ?? error.message}).`)
    );
    openDetails(conversationId, { refresh: true });
    return false;
  }
  if (done) {
    toast(done);
  }
  openDetails(conversationId, { refresh: true });
  return true;
}

function personTitle(author, conversationId, fallback = 'Someone') {
  return (author ?? authorOf(conversationId))?.title ?? fallback;
}

function groupButton(label, onClick, className = '') {
  const b = el('button', `setting-button small ${className}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', ev => {
    ev.stopPropagation();
    onClick(b);
  });
  return b;
}

function groupDetailRows(c, d) {
  const rows = [];
  const manage = canManageGroups();
  if (d.description) {
    rows.push(el('p', 'details-description', d.description));
  }
  if (manage && d.canEditGroupInfo) {
    const edit = detailRow('edit', 'Edit group', 'Name, description and photo');
    edit.classList.add('clickable');
    edit.addEventListener('click', () => {
      detailsEditing = true;
      renderDetails(c, d);
    });
    rows.push(edit);
  }

  rows.push(
    el(
      'div',
      'setting-heading',
      `${d.members.length} member${d.members.length === 1 ? '' : 's'}`
    )
  );
  if (manage && d.canAddMembers) {
    const add = detailRow('group', 'Add members');
    add.classList.add('clickable');
    add.addEventListener('click', () => openAddMembers(c, d));
    rows.push(add);
  }
  for (const m of d.members) {
    const row = el('div', 'member-row');
    const who = m.author ?? authorOf(m.conversationId) ?? { title: 'Someone' };
    const text = el('div', 'detail-text');
    text.append(el('div', 'detail-label', m.me ? 'You' : who.title));
    if (who.label?.text) {
      text.append(el('div', 'detail-sub', who.label.text));
    }
    row.append(avatar(m.conversationId, who, 36), text);
    if (m.admin) {
      row.append(el('span', 'member-admin', 'Admin'));
    }
    if (manage && d.areWeAdmin && !m.me) {
      row.classList.add('clickable');
      row.title = `Manage ${who.title}`;
      row.addEventListener('click', ev => {
        ev.stopPropagation();
        openMemberMenu(c, m, who, row);
      });
    }
    rows.push(row);
  }

  rows.push(...groupRequestRows(c, d, manage));

  if (manage && d.areWeAdmin) {
    rows.push(el('div', 'setting-heading', 'Group link'));
    rows.push(
      settingRow(
        'Group link',
        'Anyone with the link can see the group name and photo and ask to join.',
        settingSwitch(d.groupLinkEnabled, on =>
          changeGroup(c.id, { action: 'groupLink', enabled: on })
        )
      )
    );
    if (d.groupLinkEnabled) {
      if (d.groupLink) {
        const link = detailRow('copy', 'Copy link', d.groupLink);
        link.classList.add('clickable');
        link.addEventListener('click', () => copyText(d.groupLink));
        rows.push(link);
      }
      rows.push(
        settingRow(
          'Approve new members',
          'Require an admin to approve new members joining with the link.',
          settingSwitch(d.groupLinkApproval, on =>
            changeGroup(c.id, { action: 'groupLinkApproval', required: on })
          )
        )
      );
      const reset = detailRow('timer', 'Reset link');
      reset.classList.add('clickable');
      reset.addEventListener('click', () => {
        if (
          confirm(
            "Reset group link? People won't be able to join the group with the current link."
          )
        ) {
          changeGroup(
            c.id,
            { action: 'resetGroupLink' },
            { done: 'Link reset.' }
          );
        }
      });
      rows.push(reset);
    }

    rows.push(el('div', 'setting-heading', 'Permissions'));
    const who = [
      ['all', 'All members'],
      ['admins', 'Only admins'],
    ];
    rows.push(
      settingRow(
        'Add members',
        'Who can add new members to this group.',
        settingSelect(d.addMembersAccess, who, v =>
          changeGroup(c.id, { action: 'permissions', addMembers: v })
        )
      ),
      settingRow(
        'Edit group info',
        "Who can change this group's name, photo, description and disappearing messages timer.",
        settingSelect(d.editInfoAccess, who, v =>
          changeGroup(c.id, { action: 'permissions', editInfo: v })
        )
      )
    );
    if (d.canAnnounce) {
      rows.push(
        settingRow(
          'Send messages',
          'Who can send messages and start calls.',
          settingSelect(d.sendMessagesAccess, who, v =>
            changeGroup(c.id, { action: 'permissions', sendMessages: v })
          )
        )
      );
    }
  }
  return rows;
}

function groupRequestRows(c, d, manage) {
  const rows = [];
  const canAct = manage && d.areWeAdmin;
  if (d.requests.length > 0) {
    rows.push(el('div', 'setting-heading', 'Requests to join'));
    for (const r of d.requests) {
      const name = personTitle(r.author, r.conversationId);
      const row = el('div', 'member-row');
      const text = el('div', 'detail-text');
      text.append(el('div', 'detail-label', name));
      row.append(
        avatar(r.conversationId, r.author ?? { title: name }, 36),
        text
      );
      if (canAct) {
        row.append(
          groupButton('Deny', () => {
            if (confirm(`Deny the request from ${name}?`)) {
              changeGroup(c.id, {
                action: 'denyRequest',
                memberId: r.conversationId,
              });
            }
          }),
          groupButton(
            'Approve',
            () => {
              if (confirm(`Add ${name} to the group?`)) {
                changeGroup(
                  c.id,
                  { action: 'approveRequest', memberId: r.conversationId },
                  { done: `${name} added.` }
                );
              }
            },
            'primary'
          )
        );
      }
      rows.push(row);
    }
  } else if (d.requestingCount > 0) {
    rows.push(
      el(
        'p',
        'setting-note',
        `${d.requestingCount} asking to join through the group link.`
      )
    );
  }

  if (d.invites.length > 0) {
    rows.push(el('div', 'setting-heading', 'Invited'));
    const mine = d.invites.filter(i => i.invitedByMe);
    for (const i of mine) {
      const name = personTitle(i.author, i.conversationId);
      const row = el('div', 'member-row');
      const text = el('div', 'detail-text');
      text.append(
        el('div', 'detail-label', name),
        el('div', 'detail-sub', 'Invited by you')
      );
      row.append(
        avatar(i.conversationId, i.author ?? { title: name }, 36),
        text
      );
      if (manage) {
        row.append(
          groupButton('Revoke', () => {
            if (confirm(`Revoke the invitation to ${name}?`)) {
              changeGroup(c.id, {
                action: 'revokeInvites',
                memberIds: [i.conversationId],
              });
            }
          })
        );
      }
      rows.push(row);
    }
    // As Signal: others' invites only as a count per inviter.
    const byInviter = new Map();
    for (const i of d.invites.filter(x => !x.invitedByMe)) {
      const key = i.invitedBy?.title ?? 'Someone';
      byInviter.set(key, [...(byInviter.get(key) ?? []), i]);
    }
    for (const [inviter, invites] of byInviter) {
      const row = el('div', 'member-row');
      const text = el('div', 'detail-text');
      text.append(
        el('div', 'detail-label', inviter),
        el(
          'div',
          'detail-sub',
          `Invited ${invites.length} ${invites.length === 1 ? 'person' : 'people'}`
        )
      );
      row.append(
        avatar(
          `inviter:${inviter}`,
          invites[0].invitedBy ?? { title: inviter },
          36
        ),
        text
      );
      if (canAct) {
        row.append(
          groupButton('Revoke', () => {
            if (
              confirm(
                `Revoke ${invites.length === 1 ? 'the invitation' : `${invites.length} invitations`} sent by ${inviter}?`
              )
            ) {
              changeGroup(c.id, {
                action: 'revokeInvites',
                memberIds: invites.map(x => x.conversationId),
              });
            }
          })
        );
      }
      rows.push(row);
    }
  }
  return rows;
}

function openMemberMenu(c, m, who, anchor) {
  closePopovers();
  const menu = $('more-menu');
  const items = [];
  const add = (iconName, label, action) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(icon(iconName), el('span', '', label));
    item.addEventListener('click', ev => {
      ev.stopPropagation();
      closePopovers();
      action();
    });
    items.push(item);
  };
  if (conversations.has(m.conversationId)) {
    add('reply', 'Message', () => {
      closeDetails();
      selectConversation(m.conversationId);
    });
  }
  add('check', m.admin ? 'Remove as admin' : 'Make admin', () => {
    const text = m.admin
      ? `Remove ${who.title} as group admin?`
      : `Make ${who.title} a group admin? They'll be able to edit this group and its members.`;
    if (confirm(text)) {
      changeGroup(c.id, {
        action: 'setAdmin',
        memberId: m.conversationId,
        admin: !m.admin,
      });
    }
  });
  add('trash', 'Remove from group', () => {
    if (confirm(`Remove ${who.title} from ${displayTitle(c)}?`)) {
      changeGroup(
        c.id,
        { action: 'removeMember', memberId: m.conversationId },
        { done: `${who.title} removed.` }
      );
    }
  });
  menu.replaceChildren(...items);
  placePopover(menu, anchor);
}

function confirmLeave(c, d) {
  if (!canManageGroups()) {
    toast('Allow this page to change groups in Signal to use this.');
    return;
  }
  if (!d.canLeave) {
    toast('Before you leave, choose at least one new admin for this group.');
    return;
  }
  if (
    !confirm(
      'Leave group? You will no longer be able to send or receive messages in this group.'
    )
  ) {
    return;
  }
  changeGroup(c.id, { action: 'leave' }, { done: 'You left the group.' });
}

// Signal's "Edit group" dialog: name, description and photo.
function groupEditForm(c, d) {
  const form = el('form', 'group-edit');
  let photo = null;
  let photoUrl = null;
  let removePhoto = false;
  const photoButton = el('button', 'group-photo-button');
  photoButton.type = 'button';
  photoButton.title = 'Change photo';
  const showPhoto = () => {
    if (photoUrl) {
      const img = el('img');
      img.src = photoUrl;
      img.alt = '';
      photoButton.replaceChildren(img);
    } else if (removePhoto) {
      photoButton.replaceChildren(icon('group'));
    } else {
      photoButton.replaceChildren(conversationAvatar(c, 80));
    }
  };
  showPhoto();
  photoButton.addEventListener('click', () => {
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const [file] = input.files;
      if (!file) {
        return;
      }
      try {
        photo = await squarePhoto(file);
      } catch {
        toast("That file isn't a picture this browser can read.");
        return;
      }
      if (photoUrl) {
        URL.revokeObjectURL(photoUrl);
      }
      photoUrl = URL.createObjectURL(photo);
      removePhoto = false;
      showPhoto();
    });
    input.click();
  });
  const removeButton = el('button', 'setting-button small', 'Remove photo');
  removeButton.type = 'button';
  removeButton.hidden = !c.avatarVersion;
  removeButton.addEventListener('click', () => {
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
    photo = null;
    photoUrl = null;
    removePhoto = true;
    removeButton.hidden = true;
    showPhoto();
  });

  const name = el('input', 'setting-input');
  name.type = 'text';
  name.placeholder = 'Group name (required)';
  name.value = d.title ?? displayTitle(c);
  const description = el('textarea', 'setting-input');
  description.placeholder = 'Group description';
  description.rows = 3;
  description.value = d.description ?? '';
  const count = el('span', 'sub');
  const save = el('button', 'setting-button primary', 'Save');
  save.type = 'submit';
  const cancel = el('button', 'setting-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    detailsEditing = false;
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
    renderDetails(c, d);
  });
  const length = value => [...segmenter.segment(value.trim())].length;
  const update = () => {
    const n = length(name.value);
    const desc = length(description.value);
    // Signal's limits for a group name and description.
    count.textContent = `${n}/32`;
    save.disabled = n === 0 || n > 32 || desc > 480;
  };
  name.addEventListener('input', update);
  description.addEventListener('input', update);
  update();
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (save.disabled) {
      return;
    }
    save.disabled = true;
    const info = {
      conversationId: c.id,
      name: name.value.trim(),
      description: description.value.trim(),
      ...(photo ? { photo: 'set' } : removePhoto ? { photo: 'remove' } : {}),
    };
    try {
      const res = await fetch(
        `api/groupInfo?${new URLSearchParams({ info: JSON.stringify(info) })}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: photo ?? new Blob([]),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          code: data.error?.code,
        });
      }
    } catch (error) {
      toast(
        GROUP_ERRORS[error.code] ??
          `Not saved (${error.code ?? error.message}).`
      );
      update();
      return;
    }
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
    detailsEditing = false;
    toast('Group updated.');
    openDetails(c.id, { refresh: true });
  });
  const photoRow = el('div', 'group-edit-photo');
  photoRow.append(photoButton, removeButton);
  const foot = el('div', 'details-actions');
  foot.append(count, cancel, save);
  form.append(photoRow, name, description, foot);
  setTimeout(() => name.focus());
  return form;
}

function closeDetails() {
  detailsFor = null;
  $('details').hidden = true;
}

function archivedHead() {
  const li = el('li', 'archived-head');
  const back = el('button', 'icon-button', '');
  back.type = 'button';
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  back.append(icon('back'));
  back.addEventListener('click', () => {
    showArchived = false;
    renderConversations();
  });
  li.append(back, el('span', '', 'Archived chats'));
  return li;
}

function archivedLink(count) {
  const li = el('li', 'archived-link');
  const b = el('button', '', `Archived chats (${count})`);
  b.type = 'button';
  b.addEventListener('click', () => {
    showArchived = true;
    renderConversations();
    $('conversations').scrollTop = 0;
  });
  li.append(b);
  return li;
}

function renderChatHeader() {
  const c = conversations.get(selectedId);
  $('chat-title').textContent = c ? displayTitle(c) : '';
  $('chat-avatar').replaceChildren(...(c ? [conversationAvatar(c, 36)] : []));
  const sub = [];
  if (c?.type === 'group' && c.memberCount) {
    sub.push(`${c.memberCount} members`);
  }
  if (c?.muted) {
    sub.push(mutedUntilText(c)?.toLowerCase() ?? 'muted');
  }
  if (c?.disappearingSeconds) {
    sub.push(`disappearing: ${timerLabel(c.disappearingSeconds)}`);
  }
  $('chat-sub').textContent = sub.join(' · ');
  renderRequestBar();
  renderToNewest();
}

async function selectConversation(id) {
  if (id === selectedId) {
    return;
  }
  // A recording in progress stays with its chat as a draft.
  if (recording) {
    await stopRecording({ send: false });
  }
  selectedId = id;
  messages = new Map();
  nextCursor = null;
  newerCursor = null;
  unreadLine = null;
  unreadLineEl = null;
  collapseSidebar();
  renderDrafts();
  clearExpiryTimers();
  closePopovers();
  cancelReply();
  resetLinkPreview();
  scheduleLinkPreview();
  closeScheduledList();
  renderScheduledButton();
  // Mentions name members of the chat they were typed in.
  dropComposeMentions();
  $('send-error').hidden = true;
  $('empty').hidden = true;
  $('chat-head').hidden = false;
  $('messages').hidden = false;
  $('composer').hidden = false;
  renderChatHeader();
  renderConversations();
  renderVoiceDraft();
  $('message-list').replaceChildren();
  opening = true;
  privateLinks = { byGroupMessage: new Map(), byReply: new Map() };
  const links = loadPrivateLinks(id);
  try {
    await loadMessages();
    await links;
    const unread = conversations.get(id)?.unreadCount ?? 0;
    if (unread > 0) {
      await placeUnreadLine(unread);
    }
    if (id !== selectedId) {
      return;
    }
    renderMessages();
    // As Signal: open at the first unread message, else at the newest.
    if (unreadLine && unreadLineEl) {
      const box = $('messages');
      box.scrollTop +=
        unreadLineEl.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        8;
    } else {
      $('messages').scrollTop = $('messages').scrollHeight;
    }
    renderToNewest();
  } catch (error) {
    showError(`Couldn't load messages (${error.code ?? error.message}).`);
  } finally {
    if (id === selectedId) {
      opening = false;
    }
  }
  renderTyping();
  focusCompose();
  maybeMarkRead();
}

// Marks the open chat read in Signal, only while the user can see it.
async function maybeMarkRead() {
  const c = conversations.get(selectedId);
  if (markReadInFlight) {
    markReadAgain = true;
    return;
  }
  if (
    !c ||
    opening ||
    // After a jump, until the newest messages are loaded.
    newerCursor !== null ||
    // As Signal: only once you've scrolled down to the newest message.
    !nearBottom() ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus() ||
    !(c.unreadCount > 0 || c.markedUnread)
  ) {
    return;
  }
  const newest = sortedMessages().at(-1);
  if (!newest) {
    return;
  }
  markReadInFlight = true;
  try {
    await api('api/markRead', {
      conversationId: c.id,
      upToMessageId: newest.id,
    });
  } catch {
    // Signal sends conversation.updated when the count changes; nothing to do.
  } finally {
    markReadInFlight = false;
  }
  if (markReadAgain) {
    markReadAgain = false;
    maybeMarkRead();
  }
}

function showError(text) {
  $('send-error').hidden = false;
  $('send-error').textContent = text;
}

let toastTimer;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  // Long enough to read.
  toastTimer = setTimeout(
    () => {
      box.hidden = true;
    },
    Math.max(2000, text.length * 60)
  );
}

// --- message actions ---------------------------------------------------------

function closePopovers() {
  $('reaction-picker').hidden = true;
  $('more-menu').hidden = true;
  $('emoji-picker').hidden = true;
  $('reaction-viewer').hidden = true;
  $('mention-picker').hidden = true;
  $('format-menu').hidden = true;
  $('sticker-picker').hidden = true;
}

// anchor: an element, or a rect taken before its element was hidden.
function placePopover(popover, anchor) {
  popover.hidden = false;
  const a =
    'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor;
  const p = popover.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, a.left + a.width / 2 - p.width / 2),
    window.innerWidth - p.width - 8
  );
  const above = a.top - p.height - 6;
  const top = Math.max(
    8,
    Math.min(
      above >= 8 ? above : a.bottom + 6,
      window.innerHeight - p.height - 8
    )
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

async function getPreferredReactions() {
  if (!preferredReactions) {
    try {
      preferredReactions = (await api('api/reactions')).emoji;
    } catch {
      return ['❤️', '👍', '👎', '😂', '😮', '😢'];
    }
  }
  return preferredReactions;
}

async function openReactionPicker(m, anchor) {
  closePopovers();
  const picker = $('reaction-picker');
  const mine = m.reactions.find(r => r.fromMe)?.emoji;
  const emoji = await getPreferredReactions();
  picker.replaceChildren(
    ...emoji.map(e => {
      const button = el('button', `pick${e === mine ? ' mine' : ''}`);
      button.type = 'button';
      button.append(el('span', 'emoji', e));
      button.title = e === mine ? 'Remove reaction' : `React ${e}`;
      button.addEventListener('click', ev => {
        ev.stopPropagation();
        closePopovers();
        sendReaction(m, e, e === mine);
      });
      return button;
    }),
    morePicks(m, mine)
  );
  placePopover(picker, anchor);
}

// The ⋯ after the quick reactions: Signal's full picker.
function morePicks(m, mine) {
  const more = el('button', 'pick pick-more');
  more.type = 'button';
  more.title = 'More reactions';
  more.setAttribute('aria-label', 'More reactions');
  more.append(icon('more'));
  more.addEventListener('click', ev => {
    ev.stopPropagation();
    const anchor = $('reaction-picker');
    openEmojiPicker(anchor, e => sendReaction(m, e, e === mine));
  });
  return more;
}

// --- full emoji picker ---------------------------------------------------------

const EMOJI_TABS = [
  ['recent', 'cat-recent', 'Recently used'],
  ['SMILIES_AND_PEOPLE', 'cat-smileys', 'Smileys & people'],
  ['ANIMALS_AND_NATURE', 'cat-animals', 'Animals & nature'],
  ['FOOD_AND_DRINK', 'cat-food', 'Food & drink'],
  ['ACTIVITIES', 'cat-activities', 'Activities'],
  ['TRAVEL_AND_PLACES', 'cat-travel', 'Travel & places'],
  ['OBJECTS', 'cat-objects', 'Objects'],
  ['SYMBOLS', 'cat-symbols', 'Symbols'],
  ['FLAGS', 'cat-flags', 'Flags'],
];

let emojiCatalog = null;
let emojiPick = null;

async function loadEmojiCatalog() {
  emojiCatalog ??= await api('api/emoji');
  return emojiCatalog;
}

function emojiButton(e, label) {
  const button = el('button', 'emoji-cell');
  button.type = 'button';
  button.title = label ? `:${label}:` : e;
  button.append(el('span', 'emoji', e));
  button.addEventListener('click', ev => {
    ev.stopPropagation();
    const pick = emojiPick;
    closePopovers();
    pick?.(e);
  });
  return button;
}

function emojiSection(id, title, cells) {
  const section = el('div', 'emoji-section');
  section.dataset.category = id;
  section.append(
    el('div', 'emoji-section-title', title),
    el('div', 'emoji-grid')
  );
  section.lastChild.append(...cells);
  return section;
}

async function openEmojiPicker(anchorElement, onPick) {
  const anchor = anchorElement.getBoundingClientRect();
  const picker = $('emoji-picker');
  emojiPick = onPick;
  let catalog;
  let recent = [];
  try {
    [catalog, { recent = [] }] = await Promise.all([
      loadEmojiCatalog(),
      api('api/reactions'),
    ]);
  } catch (error) {
    toast(`Couldn't load emoji (${error.code ?? error.message}).`);
    return;
  }
  closePopovers();
  emojiPick = onPick;

  const names = new Map();
  for (const category of catalog.categories) {
    for (const [e, name] of category.emoji) {
      names.set(e, name);
    }
  }

  const search = el('input', 'emoji-search');
  search.type = 'search';
  search.placeholder = 'Search emoji';
  search.autocomplete = 'off';
  search.spellcheck = false;
  const body = el('div', 'emoji-body');
  const tabs = el('div', 'emoji-tabs');

  const sections = [];
  if (recent.length > 0) {
    sections.push(
      emojiSection(
        'recent',
        'Recently Used',
        recent.map(e => emojiButton(e, names.get(e)))
      )
    );
  }
  for (const category of catalog.categories) {
    const title = EMOJI_TABS.find(([id]) => id === category.id)?.[2] ?? '';
    sections.push(
      emojiSection(
        category.id,
        title,
        category.emoji.map(([e, name]) => emojiButton(e, name))
      )
    );
  }
  body.replaceChildren(...sections);

  for (const [id, tabIcon, title] of EMOJI_TABS) {
    const target = sections.find(sec => sec.dataset.category === id);
    if (!target) {
      continue;
    }
    const tab = el('button', 'emoji-tab');
    tab.type = 'button';
    tab.title = title;
    tab.setAttribute('aria-label', title);
    tab.append(icon(tabIcon));
    tab.addEventListener('click', ev => {
      ev.stopPropagation();
      search.value = '';
      body.replaceChildren(...sections);
      body.scrollTop = target.offsetTop - body.offsetTop;
    });
    tabs.append(tab);
  }

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase().replace(/^:/, '');
    if (query === '') {
      body.replaceChildren(...sections);
      return;
    }
    const words = query.split(/\s+/);
    const found = [];
    for (const [e, name] of names) {
      const label = name.toLowerCase();
      if (words.every(w => label.includes(w))) {
        found.push(emojiButton(e, name));
      }
      if (found.length >= 200) {
        break;
      }
    }
    body.replaceChildren(
      found.length > 0
        ? emojiSection('search', 'Results', found)
        : el('div', 'emoji-none', 'No emoji found')
    );
  });
  search.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      body.querySelector('.emoji-cell')?.click();
    }
  });

  // Signal's skin tone choice, beside the search box.
  const head = el('div', 'emoji-head');
  head.append(search);
  if (canManageSettings() && signalSettings) {
    const current =
      SKIN_TONE_HANDS.find(([tone]) => tone === signalSettings.emojiSkinTone) ??
      SKIN_TONE_HANDS[0];
    const toneButton = el('button', 'emoji-tone-button');
    toneButton.type = 'button';
    toneButton.title = 'Skin tone';
    toneButton.setAttribute('aria-label', 'Skin tone');
    toneButton.append(el('span', 'emoji', current[1]));
    const tones = skinTonePicker(signalSettings.emojiSkinTone, async tone => {
      await changeSetting('emojiSkinTone', tone);
      openEmojiPicker(anchorElement, onPick);
    });
    tones.hidden = true;
    toneButton.addEventListener('click', ev => {
      ev.stopPropagation();
      tones.hidden = !tones.hidden;
    });
    head.append(toneButton);
    picker.replaceChildren(head, tones, body, tabs);
  } else {
    picker.replaceChildren(head, body, tabs);
  }
  placePopover(picker, anchor);
  search.focus();
}

// --- settings -------------------------------------------------------------------

// Signal's own settings (the ones that make sense here), plus the page's
// theme. Account-wide ones change on every device, as in Signal.
let signalSettings = null;
let settingsSection = 'profile';
// Signal's profile (profile.get), and the edits not saved yet.
let signalProfile = null;
let profileDraft = null;
let profileSaving = false;

const SKIN_TONE_HANDS = [
  ['', '✋', 'Default (yellow)'],
  ['1F3FB', '✋🏻', 'Light'],
  ['1F3FC', '✋🏼', 'Medium-light'],
  ['1F3FD', '✋🏽', 'Medium'],
  ['1F3FE', '✋🏾', 'Medium-dark'],
  ['1F3FF', '✋🏿', 'Dark'],
];

const DISAPPEARING_CHOICES = [
  [0, 'Off'],
  [4 * 7 * 86400, '4 weeks'],
  [7 * 86400, '1 week'],
  [86400, '1 day'],
  [8 * 3600, '8 hours'],
  [3600, '1 hour'],
  [300, '5 minutes'],
  [30, '30 seconds'],
];

function canManageSettings() {
  return capabilities.includes('settings.manage');
}

async function loadSettings() {
  if (!canManageSettings()) {
    signalSettings = null;
    return null;
  }
  try {
    ({ settings: signalSettings } = await api('api/settings'));
  } catch {
    // Older Signal: the page works without them.
  }
  return signalSettings;
}

async function loadProfile() {
  if (!canManageSettings()) {
    signalProfile = null;
    return;
  }
  try {
    ({ profile: signalProfile } = await api('api/profile'));
    profileDraft = null;
  } catch {
    // Older Signal: no profile editor.
  }
}

const PROFILE_FIELDS = ['firstName', 'familyName', 'aboutText', 'aboutEmoji'];

function profileValues() {
  return profileDraft ?? signalProfile;
}

function editProfile(field, value) {
  profileDraft = { ...profileValues(), [field]: value };
}

function profileChanged() {
  return (
    profileDraft !== null &&
    PROFILE_FIELDS.some(field => profileDraft[field] !== signalProfile[field])
  );
}

async function saveProfile() {
  const draft = profileValues();
  if (draft.firstName.trim() === '') {
    toast('Your first name is required.');
    return;
  }
  profileSaving = true;
  renderSettings();
  try {
    ({ profile: signalProfile } = await api(
      'api/profile',
      Object.fromEntries(PROFILE_FIELDS.map(field => [field, draft[field]]))
    ));
    profileDraft = null;
    toast('Profile saved.');
  } catch (error) {
    toast(
      error.code === 'INVALID_ARGUMENT'
        ? 'Not saved: a name is up to 26 characters, about up to 140.'
        : `Not saved (${error.code ?? error.message}).`
    );
  }
  profileSaving = false;
  renderSettings();
}

// As Signal's avatar editor: a centered square, at most 512 pixels.
async function squarePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(side, 512);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  canvas
    .getContext('2d')
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      out,
      out
    );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('not an image'))),
      'image/jpeg',
      0.9
    )
  );
}

// photo: a Blob, or null to remove it.
async function changeProfilePhoto(photo) {
  profileSaving = true;
  renderSettings();
  try {
    const res = await fetch('api/profilePhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: photo ?? new Blob([]),
    });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: data.error?.code,
      });
    }
    signalProfile = data.profile;
    toast(photo ? 'Photo changed.' : 'Photo removed.');
  } catch (error) {
    toast(`Photo not changed (${error.code ?? error.message}).`);
  }
  profileSaving = false;
  renderSettings();
}

function pickProfilePhoto() {
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const [file] = input.files;
    if (!file) {
      return;
    }
    let photo;
    try {
      photo = await squarePhoto(file);
    } catch {
      toast("That file isn't a picture this browser can read.");
      return;
    }
    await changeProfilePhoto(photo);
  });
  input.click();
}

function profileInput(field, placeholder, maxLength) {
  const input = el('input', 'setting-input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.value = profileValues()[field];
  input.disabled = profileSaving;
  input.addEventListener('input', () => {
    editProfile(field, input.value);
    $('profile-save').disabled = profileSaving || !profileChanged();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && profileChanged()) {
      saveProfile();
    }
  });
  return input;
}

function profileRows() {
  const p = profileValues();
  const photo = el('div', 'profile-photo');
  photo.append(
    avatar(
      signalProfile.conversationId,
      {
        title: [signalProfile.firstName, signalProfile.familyName].join(' '),
        avatarColor: signalProfile.avatarColor,
        avatarVersion: signalProfile.avatarVersion,
      },
      80
    )
  );
  const photoButtons = el('div', 'profile-photo-buttons');
  const change = el('button', 'setting-button', 'Change photo');
  change.type = 'button';
  change.disabled = profileSaving;
  change.addEventListener('click', pickProfilePhoto);
  photoButtons.append(change);
  if (signalProfile.avatarVersion) {
    const remove = el('button', 'setting-button', 'Remove photo');
    remove.type = 'button';
    remove.disabled = profileSaving;
    remove.addEventListener('click', () => {
      if (confirm('Remove your profile photo?')) {
        changeProfilePhoto(null);
      }
    });
    photoButtons.append(remove);
  }
  photo.append(photoButtons);

  const names = el('div', 'profile-fields');
  names.append(
    profileInput('firstName', 'First name (required)', 26),
    profileInput('familyName', 'Last name (optional)', 26)
  );

  const about = el('div', 'profile-fields profile-about');
  const emoji = el('button', 'profile-emoji');
  emoji.type = 'button';
  emoji.title = 'About emoji';
  emoji.disabled = profileSaving;
  if (p.aboutEmoji) {
    emoji.append(el('span', 'emoji', p.aboutEmoji));
  } else {
    emoji.append(icon('react'));
  }
  emoji.addEventListener('click', ev => {
    ev.stopPropagation();
    openEmojiPicker(emoji, picked => {
      closePopovers();
      editProfile('aboutEmoji', picked);
      renderSettings();
    });
  });
  about.append(
    emoji,
    profileInput('aboutText', 'Write a few words about yourself', 140)
  );
  if (p.aboutEmoji || p.aboutText) {
    const clear = el('button', 'setting-button', 'Clear');
    clear.type = 'button';
    clear.disabled = profileSaving;
    clear.addEventListener('click', () => {
      editProfile('aboutEmoji', '');
      editProfile('aboutText', '');
      renderSettings();
    });
    about.append(clear);
  }

  const actions = el('div', 'profile-actions');
  const save = el(
    'button',
    'setting-button primary',
    profileSaving ? 'Saving…' : 'Save'
  );
  save.id = 'profile-save';
  save.type = 'button';
  save.disabled = profileSaving || !profileChanged();
  save.addEventListener('click', saveProfile);
  actions.append(save);
  if (profileDraft) {
    const cancel = el('button', 'setting-button', 'Cancel');
    cancel.type = 'button';
    cancel.disabled = profileSaving;
    cancel.addEventListener('click', () => {
      profileDraft = null;
      renderSettings();
    });
    actions.append(cancel);
  }

  return [
    photo,
    el('div', 'setting-heading', 'Name'),
    names,
    el('div', 'setting-heading', 'About'),
    about,
    actions,
    settingRow(
      'Username',
      signalProfile.username
        ? 'Change or remove it in Signal on your phone.'
        : 'Set one in Signal on your phone.',
      el('span', 'setting-value', signalProfile.username ?? 'None')
    ),
    el(
      'p',
      'setting-note',
      'Your profile is visible to the people and groups you message, and to anyone you accept a message request from.'
    ),
  ];
}

function blockedRows(blocked) {
  if (blocked.length === 0) {
    return [el('p', 'setting-note', 'Nobody is blocked.')];
  }
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const groups = [
    ['Contacts', blocked.filter(b => b.type === 'direct')],
    ['Groups', blocked.filter(b => b.type === 'group')],
  ];
  return groups
    .filter(([, list]) => list.length > 0)
    .flatMap(([heading, list]) => [
      el('div', 'setting-heading', heading),
      ...list.map(b => {
        const row = el('div', 'blocked-row');
        const text = el('div', 'setting-text');
        text.append(el('div', 'setting-label', b.title));
        if (b.blockedAt) {
          text.append(
            el(
              'div',
              'setting-desc',
              `Blocked on ${dateFormat.format(new Date(b.blockedAt))}`
            )
          );
        }
        row.append(avatar(b.conversationId, b, 36, b.type), text);
        return row;
      }),
    ]);
}

async function changeSetting(key, value) {
  try {
    ({ settings: signalSettings } = await api('api/settings', { key, value }));
    if (key === 'emojiSkinTone') {
      emojiCatalog = null;
    }
  } catch (error) {
    toast(`Not changed (${error.code ?? error.message}).`);
  }
  renderSettings();
}

// The page's theme: Signal's light or dark, or the system's.
function pageTheme() {
  try {
    return localStorage.getItem('theme') ?? 'system';
  } catch {
    return 'system';
  }
}

// The stylesheet's dark rules, by their original media query.
const darkRuleMedia = new WeakMap();

function applyTheme(theme) {
  document.documentElement.style.colorScheme =
    theme === 'system' ? 'light dark' : theme;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSMediaRule)) {
        continue;
      }
      if (!darkRuleMedia.has(rule)) {
        darkRuleMedia.set(rule, rule.media.mediaText);
      }
      const media = darkRuleMedia.get(rule);
      if (!media.includes('prefers-color-scheme: dark')) {
        continue;
      }
      // The dark rules apply always, never, or as the system says.
      rule.media.mediaText =
        theme === 'dark' ? 'all' : theme === 'light' ? 'not all' : media;
    }
  }
}

function setPageTheme(theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Storage blocked; the theme still applies until reload.
  }
  applyTheme(theme);
  renderSettings();
}

function settingRow(label, description, control) {
  const row = el('div', 'setting-row');
  const text = el('div', 'setting-text');
  text.append(el('div', 'setting-label', label));
  if (description) {
    text.append(el('div', 'setting-desc', description));
  }
  row.append(text, control);
  return row;
}

function settingSwitch(checked, onChange, disabled = false) {
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function settingSelect(value, choices, onChange, disabled = false) {
  const select = el('select', 'setting-select');
  for (const [v, label] of choices) {
    const option = el('option', '', label);
    option.value = String(v);
    option.selected = String(v) === String(value);
    select.append(option);
  }
  select.disabled = disabled;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function skinTonePicker(value, onPick) {
  const row = el('div', 'tone-picker');
  for (const [tone, hand, label] of SKIN_TONE_HANDS) {
    const b = el('button', `tone${tone === value ? ' active' : ''}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(tone === value));
    b.append(el('span', 'emoji', hand));
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      onPick(tone);
    });
    row.append(b);
  }
  return row;
}

function storiesButton(enabled, onChange) {
  const b = el(
    'button',
    `setting-button${enabled ? ' danger' : ''}`,
    enabled ? 'Turn off stories' : 'Turn on stories'
  );
  b.type = 'button';
  b.addEventListener('click', () => {
    if (
      enabled &&
      !confirm(
        'You will no longer be able to share or view stories. Story updates you have recently shared will also be deleted.'
      )
    ) {
      return;
    }
    onChange(!enabled);
  });
  return b;
}

function settingsSections() {
  const s = signalSettings;
  const set = (key, value) => changeSetting(key, value);
  const sections = [];
  if (signalProfile) {
    sections.push({ id: 'profile', title: 'Profile', rows: profileRows });
  }
  sections.push({
    id: 'appearance',
    title: 'Appearance',
    rows: () => [
      settingRow(
        'Theme',
        'For this page. Signal on your phone keeps its own.',
        settingSelect(
          pageTheme(),
          [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ],
          setPageTheme
        )
      ),
    ],
  });
  if (!s) {
    return sections;
  }
  sections.push(
    {
      id: 'chats',
      title: 'Chats',
      rows: () => [
        settingRow(
          'Default emoji skin tone',
          'Used for emoji with skin tones in the emoji picker.',
          skinTonePicker(s.emojiSkinTone, tone => set('emojiSkinTone', tone))
        ),
        settingRow(
          'Generate link previews',
          'Retrieve link previews directly from websites for messages you send. Applies to all your devices.',
          settingSwitch(s.linkPreviews, v => set('linkPreviews', v))
        ),
        settingRow(
          'Sent media quality',
          'High quality sends photos and videos at full resolution.',
          settingSelect(
            s.sentMediaQuality,
            [
              ['standard', 'Standard'],
              ['high', 'High'],
            ],
            v => set('sentMediaQuality', v)
          )
        ),
        settingRow(
          'Keep muted chats archived',
          'Muted chats that are archived will remain archived when a new message arrives.',
          settingSwitch(s.keepMutedChatsArchived, v =>
            set('keepMutedChatsArchived', v)
          )
        ),
      ],
    },
    {
      id: 'notifications',
      title: 'Notifications',
      rows: () => [
        settingRow(
          'Notification content',
          'What this page shows when a message arrives.',
          settingSelect(
            s.notificationContent,
            [
              ['message', 'Name, content, and actions'],
              ['name', 'Name only'],
              ['count', 'No name or content'],
              ['off', 'Off'],
            ],
            v => set('notificationContent', v)
          )
        ),
        settingRow(
          'Notification sound',
          "Play Signal's sound with each notification.",
          settingSwitch(s.notificationSound, v => set('notificationSound', v))
        ),
        settingRow(
          'Reaction notifications',
          'Notify when someone reacts to your messages. Applies to all your devices.',
          settingSwitch(s.reactionNotifications, v =>
            set('reactionNotifications', v)
          )
        ),
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      rows: () => [
        settingRow(
          'Read receipts',
          "If read receipts are disabled, you won't be able to see read receipts from others. Applies to all your devices.",
          settingSwitch(s.readReceipts, v => set('readReceipts', v))
        ),
        settingRow(
          'Typing indicators',
          "If typing indicators are disabled, you won't be able to see typing indicators from others. Applies to all your devices.",
          settingSwitch(s.typingIndicators, v => set('typingIndicators', v))
        ),
        settingRow(
          'Default timer for new chats',
          'Set a default disappearing message timer for all new chats started by you.',
          settingSelect(
            s.disappearingMessagesSeconds,
            DISAPPEARING_CHOICES.some(
              ([v]) => v === s.disappearingMessagesSeconds
            )
              ? DISAPPEARING_CHOICES
              : [
                  ...DISAPPEARING_CHOICES,
                  [s.disappearingMessagesSeconds, 'Custom (set in Signal)'],
                ],
            v => set('disappearingMessagesSeconds', Number(v))
          )
        ),
        settingRow(
          'Who can see my phone number',
          'Applies to all your devices.',
          settingSelect(
            s.phoneNumberSharing,
            [
              ['everybody', 'Everyone'],
              ['nobody', 'Nobody'],
            ],
            v => set('phoneNumberSharing', v)
          )
        ),
        settingRow(
          'Who can find me by number',
          s.phoneNumberSharing === 'everybody'
            ? 'Everyone can, while everyone can see your number.'
            : 'Applies to all your devices.',
          settingSelect(
            s.phoneNumberDiscoverable ? 'everybody' : 'nobody',
            [
              ['everybody', 'Everyone'],
              ['nobody', 'Nobody'],
            ],
            v => set('phoneNumberDiscoverable', v === 'everybody'),
            s.phoneNumberSharing === 'everybody'
          )
        ),
        settingRow(
          'Show status icon',
          'Show an icon in message details when messages were delivered using sealed sender. Applies to all your devices.',
          settingSwitch(s.sealedSenderIndicators, v =>
            set('sealedSenderIndicators', v)
          )
        ),
        settingRow(
          'Stories',
          s.storiesEnabled
            ? 'Turning stories off deletes the stories you shared, and you will no longer share or view them. Applies to all your devices.'
            : 'Stories are off. Applies to all your devices.',
          storiesButton(s.storiesEnabled, v => set('storiesEnabled', v))
        ),
      ],
    },
    {
      id: 'blocked',
      title: 'Blocked',
      rows: () => [
        el(
          'p',
          'setting-note',
          "Blocked people and groups can't message or call you. Unblock one from its chat."
        ),
        ...blockedRows(s.blocked ?? []),
      ],
    },
    {
      id: 'data',
      title: 'Data usage',
      rows: () => [
        el(
          'div',
          'setting-heading',
          'Media auto-download (on the computer running Signal)'
        ),
        ...[
          ['photos', 'Images'],
          ['videos', 'Videos'],
          ['audio', 'Audio'],
          ['documents', 'Documents'],
        ].map(([kind, label]) =>
          settingRow(
            label,
            null,
            settingSwitch(s.autoDownload[kind], v =>
              set('autoDownload', { ...s.autoDownload, [kind]: v })
            )
          )
        ),
      ],
    }
  );
  sections.push({
    id: 'elsewhere',
    title: 'In Signal on your phone',
    rows: () => [
      el(
        'p',
        'setting-note',
        'Linked devices, backups, changing your number and deleting data stay in Signal itself, so one click in a browser tab can never lock you out.'
      ),
    ],
  });
  return sections;
}

function renderSettings() {
  if ($('settings').hidden) {
    return;
  }
  const sections = settingsSections();
  const current =
    sections.find(section => section.id === settingsSection) ?? sections[0];
  $('settings-nav').replaceChildren(
    ...sections.map(section => {
      const b = el(
        'button',
        `settings-tab${section === current ? ' active' : ''}`,
        section.title
      );
      b.type = 'button';
      b.addEventListener('click', () => {
        settingsSection = section.id;
        renderSettings();
      });
      return b;
    })
  );
  const page = $('settings-page');
  page.replaceChildren(
    el('h2', 'settings-heading', current.title),
    ...current.rows()
  );
  if (!signalSettings && canManageSettings()) {
    page.append(el('p', 'setting-note', "Couldn't load Signal's settings."));
  } else if (!canManageSettings()) {
    page.append(
      el(
        'p',
        'setting-note',
        "Signal's own settings appear here once this page is allowed to manage them (Signal asks when the helper reconnects)."
      )
    );
  }
}

async function openSettings() {
  closePopovers();
  $('settings').hidden = false;
  renderSettings();
  await Promise.all([loadSettings(), loadProfile()]);
  renderSettings();
}

function closeSettings() {
  $('settings').hidden = true;
}

// --- stickers -------------------------------------------------------------------

// As Signal's sticker picker: Recently used, then each installed pack, and a
// sticker is sent as soon as it is picked.
const STICKER_CELL_PX = 72;
let stickerTab = null;

function stickerImageUrl(packId, stickerId, size) {
  const params = new URLSearchParams({
    packId,
    stickerId: String(stickerId),
    width: String(Math.round(size * (window.devicePixelRatio || 1))),
  });
  return `api/stickerImage?${params}`;
}

function stickerImage(packId, stickerId, size, label) {
  const img = el('img', 'sticker-img');
  img.loading = 'lazy';
  img.alt = label ?? '';
  img.src = stickerImageUrl(packId, stickerId, size);
  return img;
}

async function sendSticker(packId, stickerId) {
  const conversationId = selectedId;
  if (!conversationId) {
    return;
  }
  closePopovers();
  $('send-error').hidden = true;
  try {
    // A pending reply goes with the sticker, as Signal's composer does
    // behind its sticker-reply switch.
    const quote = replyTo && !editing ? replyTo : null;
    await api('api/sendSticker', {
      conversationId,
      packId,
      stickerId,
      ...(quote ? { quoteMessageId: quote.id } : {}),
    });
    if (quote && replyTo === quote) {
      cancelReply();
    }
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`
    );
  }
}

async function openStickerPicker(anchorElement) {
  const anchor = anchorElement.getBoundingClientRect();
  let data;
  try {
    data = await api('api/stickers');
  } catch (error) {
    toast(`Couldn't load stickers (${error.code ?? error.message}).`);
    return;
  }
  closePopovers();
  const picker = $('sticker-picker');
  const tabs = el('div', 'sticker-tabs');
  const title = el('div', 'emoji-section-title');
  const grid = el('div', 'sticker-grid');
  const body = el('div', 'emoji-body');
  body.append(title, grid);

  const sources = [];
  if (data.recents.length > 0) {
    sources.push({
      key: 'recent',
      title: 'Recently used',
      stickers: data.recents.map(r => ({
        packId: r.packId,
        id: r.stickerId,
        emoji: r.emoji,
      })),
    });
  }
  for (const pack of data.packs) {
    sources.push({
      key: pack.id,
      title: pack.author ? `${pack.title} · ${pack.author}` : pack.title,
      pack,
      stickers: pack.stickers.map(st => ({ ...st, packId: pack.id })),
    });
  }

  const show = source => {
    stickerTab = source.key;
    title.textContent = source.title;
    grid.replaceChildren(
      ...source.stickers.map(st => {
        const cell = el('button', 'sticker-cell');
        cell.type = 'button';
        cell.title = st.emoji ?? '';
        cell.append(stickerImage(st.packId, st.id, STICKER_CELL_PX, st.emoji));
        cell.addEventListener('click', ev => {
          ev.stopPropagation();
          sendSticker(st.packId, st.id);
        });
        return cell;
      })
    );
    body.scrollTop = 0;
    for (const tab of tabs.children) {
      tab.classList.toggle('active', tab.dataset.key === source.key);
    }
  };

  for (const source of sources) {
    const tab = el('button', 'sticker-tab');
    tab.type = 'button';
    tab.dataset.key = source.key;
    tab.title = source.title;
    tab.setAttribute('aria-label', source.title);
    if (source.pack) {
      const cover = source.pack.coverStickerId ?? source.stickers[0]?.id;
      if (cover !== undefined) {
        const img = stickerImage(source.pack.id, cover, 28, '');
        // A cover Signal hasn't fetched yet: the first sticker instead.
        const first = source.stickers[0]?.id;
        img.addEventListener(
          'error',
          () => {
            if (first !== undefined && first !== cover) {
              img.src = stickerImageUrl(source.pack.id, first, 28);
            }
          },
          { once: true }
        );
        tab.append(img);
      }
    } else {
      tab.append(icon('cat-recent'));
    }
    tab.addEventListener('click', ev => {
      ev.stopPropagation();
      show(source);
    });
    tabs.append(tab);
  }

  if (sources.length === 0) {
    picker.replaceChildren(
      el(
        'div',
        'emoji-none',
        'No sticker packs installed. Add some in Signal (Stickers, then the + button).'
      )
    );
  } else {
    picker.replaceChildren(body, tabs);
    show(sources.find(source => source.key === stickerTab) ?? sources[0]);
  }
  placePopover(picker, anchor);
}

// The composer's emoji button inserts at the cursor.
function insertEmoji(e) {
  insertPlain(e);
  // Into Signal's recently used list, as its own picker does.
  api('api/emojiUsed', { emoji: e }).catch(() => {});
}

async function sendReaction(m, emoji, remove) {
  try {
    await api('api/react', { messageId: m.id, emoji, remove });
  } catch (error) {
    toast(
      SEND_ERRORS[error.reason] ??
        `Couldn't react (${error.code ?? error.message}).`
    );
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied');
}

function openMoreMenu(m, anchor) {
  closePopovers();
  const menu = $('more-menu');
  const items = [];
  const add = (iconName, label, action) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.append(icon(iconName), el('span', '', label));
    item.addEventListener('click', ev => {
      ev.stopPropagation();
      closePopovers();
      action();
    });
    items.push(item);
  };
  if (m.kind === 'text' && m.body) {
    add('copy', 'Copy text', () => copyText(toUnicode(messagePieces(m))));
  }
  if (canReplyTo(m)) {
    add('reply', 'Reply', () => startReply(m));
  }
  if (
    canReplyTo(m) &&
    m.direction !== 'outgoing' &&
    m.authorConversationId &&
    conversations.get(selectedId)?.type === 'group'
  ) {
    add('reply', 'Reply privately', () => replyPrivately(m));
  }
  if (canForward(m)) {
    add('forward', 'Forward', () => openForward(m));
  }
  if (m.poll && canSend()) {
    add('forward', 'Send this poll to…', () =>
      openPollForward(
        {
          question: m.poll.question,
          options: m.poll.options.map(option => option.text),
          allowMultiple: m.poll.allowMultiple,
        },
        []
      )
    );
  }
  if (m.poll?.canEnd && canSend()) {
    add('poll', 'End poll', () => endPoll(m));
  }
  if (m.canEdit) {
    add('edit', 'Edit', () => startEdit(m));
  }
  add('trash', 'Delete for me', () => deleteMessage(m, false));
  if (m.canDeleteForEveryone) {
    add('trash', 'Delete for everyone', () => deleteMessage(m, true));
  }
  if (items.length === 0) {
    items.push(el('span', 'menu-empty', 'Nothing to do here'));
  }
  menu.replaceChildren(...items);
  placePopover(menu, anchor);
}

// Beyond Signal (decision F23): open the direct chat with the sender and
// quote their group message there.
async function replyPrivately(m) {
  const groupId = selectedId;
  await openContact(m.authorConversationId);
  if (selectedId !== m.authorConversationId) {
    return;
  }
  startReply({ ...m, privateFrom: groupId });
}

function startReply(m) {
  replyTo = m;
  const quote = $('reply-quote');
  const name =
    m.direction === 'outgoing' ? 'You' : nameOf(m.authorConversationId);
  quote.replaceChildren(
    nameLine(
      name,
      m.direction === 'outgoing' ? null : m.author,
      'quote-author'
    ),
    el(
      'span',
      'quote-text',
      m.kind === 'text' && !m.body && m.attachments[0]
        ? quoteLabel(m.attachments[0])
        : summarize(m)
    )
  );
  quote.className = 'reply-quote';
  if (m.direction !== 'outgoing' && m.author?.nameColor) {
    quote.classList.add(`nc-${m.author.nameColor}`);
  }
  if (m.kind === 'text' && m.attachments[0]?.hasThumbnail) {
    addQuoteThumb(
      quote,
      `api/thumbnail?${attachmentParams(m, 0, {
        width: String(previewWidth(QUOTE_THUMB_PX)),
      })}`
    );
  }
  $('reply-bar').hidden = false;
  focusCompose();
}

function cancelReply() {
  const wasEditing = editing !== null;
  replyTo = null;
  editing = null;
  $('reply-bar').hidden = true;
  $('reply-bar').classList.remove('editing');
  if (wasEditing) {
    setCompose('');
  }
}

// Edit mode reuses the reply bar to show what is being edited.
function startEdit(m) {
  cancelReply();
  editing = m;
  const quote = $('reply-quote');
  quote.className = 'reply-quote';
  quote.replaceChildren(
    el('span', 'quote-author', 'Edit message'),
    el('span', 'quote-text', summarize(m))
  );
  $('reply-bar').classList.add('editing');
  $('reply-bar').hidden = false;
  setCompose(m.body ?? '', m.mentions ?? [], m.formatting ?? []);
  focusCompose({ end: true });
}

async function deleteMessage(m, forEveryone) {
  const question = forEveryone
    ? 'Delete this message for everyone?'
    : 'Delete this message for you?';
  if (!window.confirm(question)) {
    return;
  }
  try {
    await api('api/delete', { messageId: m.id, forEveryone });
    if (!forEveryone && messages.delete(m.id)) {
      renderMessages();
    }
  } catch (error) {
    toast(`Not deleted (${error.code ?? error.message}).`);
  }
}

// --- notifications -----------------------------------------------------------

function notify(m) {
  const c = conversations.get(m.conversationId);
  if (!c || c.muted || m.direction !== 'incoming') {
    return;
  }
  if (document.hasFocus() && selectedId === m.conversationId) {
    return;
  }
  if (!('Notification' in window) || Notification.permission === 'denied') {
    return;
  }
  // Signal's "Notification content" setting.
  const content = signalSettings?.notificationContent ?? 'message';
  if (content === 'off') {
    return;
  }
  const show = () => {
    const text = summarize(m);
    let title = displayTitle(c);
    let body =
      c.type === 'group' ? `${nameOf(m.authorConversationId)}: ${text}` : text;
    if (content === 'name') {
      body = 'New message';
    } else if (content === 'count') {
      title = 'Backchannel';
      body = 'New message';
    }
    if (signalSettings?.notificationSound) {
      new Audio('sounds/notification.ogg').play().catch(() => {});
    }
    const n = new Notification(title, {
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
      tag: m.conversationId,
      icon:
        content !== 'count' && c.avatarVersion
          ? `api/avatar?${new URLSearchParams({ conversationId: c.id, v: c.avatarVersion })}`
          : 'icon.svg',
    });
    n.addEventListener('click', () => {
      window.focus();
      selectConversation(m.conversationId);
    });
  };
  if (Notification.permission === 'granted') {
    show();
  } else {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        show();
      }
    });
  }
}

// --- live updates --------------------------------------------------------------

async function loadState() {
  const state = await api('api/state');
  bridgeState = state.state;
  capabilities = state.capabilities ?? [];
  loadSettings();
  preferredReactions = null;
  conversations.clear();
  rowCache.clear();
  for (const c of state.conversations) {
    conversations.set(c.id, c);
  }
  renderBanner();
  renderTitle();
  renderConversations();
  loadScheduled().catch(() => {});
  if (selectedId && !conversations.has(selectedId)) {
    selectedId = null;
    cancelReply();
    $('empty').hidden = false;
    $('chat-head').hidden = true;
    $('messages').hidden = true;
    $('composer').hidden = true;
  } else if (selectedId && bridgeState === 'ready') {
    renderChatHeader();
    messages = new Map();
    clearExpiryTimers();
    await loadMessages();
  }
}

const HELPER_DOWN_AFTER_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
let disconnectedSince = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

function connectEvents() {
  const source = new EventSource('api/events');
  const on = (type, handler) =>
    source.addEventListener(type, e => handler(JSON.parse(e.data)));

  on('hello', () => {
    helperConnected = true;
    disconnectedSince = null;
    reconnectDelay = 1000;
    renderBanner();
    loadState().catch(() => {});
  });
  on('resync', () => loadState().catch(() => {}));
  on('scheduled.changed', ({ counts }) => {
    scheduledCounts = counts;
    renderScheduledButton();
    if (!$('scheduled').hidden) {
      loadScheduled().catch(() => {});
    }
  });
  on('state', ({ state }) => {
    bridgeState = state;
    if (state !== 'ready') {
      typingIn.clear();
      conversations.clear();
      renderConversations();
      renderTitle();
    }
    renderBanner();
  });
  on('conversation.updated', c => {
    conversations.set(c.id, c);
    renderConversations();
    renderTitle();
    if (c.id === selectedId) {
      renderChatHeader();
      maybeMarkRead();
    }
  });
  on('typing.changed', ({ conversationId, typists }) => {
    for (const t of typists) {
      if (t.author) {
        authors.set(t.authorConversationId, t.author);
      }
    }
    if (typists.length > 0) {
      typingIn.set(conversationId, typists);
    } else {
      typingIn.delete(conversationId);
    }
    renderConversations();
    if (conversationId === selectedId) {
      renderTyping();
    }
  });
  on('conversation.removed', ({ conversationId }) => {
    conversations.delete(conversationId);
    rowCache.delete(conversationId);
    renderConversations();
    renderTitle();
  });
  on('message.added', m => {
    rememberAuthors(m);
    // After a jump, it arrives when paging reaches the newest.
    if (m.conversationId === selectedId && newerCursor === null) {
      putMessage(m);
      renderMessages();
      maybeMarkRead();
    }
    notify(m);
  });
  on('message.updated', m => {
    if (m.conversationId === selectedId && messages.has(m.id)) {
      putMessage(m);
      renderMessages();
    }
  });
  on('message.removed', ({ messageId }) => {
    if (messages.delete(messageId)) {
      renderMessages();
    }
  });
  source.addEventListener('error', () => {
    helperConnected = false;
    disconnectedSince ??= Date.now();
    renderBanner();
    // EventSource retries a dropped stream by itself, but gives up for good
    // when the reconnect gets an error status (a reverse proxy's 502 while
    // the helper restarts). Start over then, backing off up to 5 s.
    if (source.readyState === EventSource.CLOSED) {
      source.close();
      clearTimeout(reconnectTimer);
      const delay = reconnectDelay * (0.8 + Math.random() * 0.4);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(connectEvents, delay);
    }
  });
}

// --- composer ------------------------------------------------------------------

// What the message box and the tray hold, ready to send; null if nothing.
function prepareCompose() {
  const {
    body: rawBody,
    mentions: rawMentions,
    formatting: rawFormatting,
  } = composeForSend();
  const conversationId = selectedId;
  const files = editing ? [] : draftsFor(conversationId);
  if (!conversationId || (rawBody.trim() === '' && files.length === 0)) {
    return null;
  }
  // A caption is trimmed; mentions move with it.
  const lead =
    files.length > 0 ? rawBody.length - rawBody.trimStart().length : 0;
  const body = files.length > 0 ? rawBody.trim() : rawBody;
  const mentions = rawMentions
    .map(mention => ({ ...mention, start: mention.start - lead }))
    .filter(mention => mention.start >= 0 && mention.start < body.length);
  const formatting = rawFormatting.flatMap(range => {
    const start = Math.max(0, range.start - lead);
    const end = Math.min(body.length, range.start + range.length - lead);
    return end > start ? [{ ...range, start, length: end - start }] : [];
  });
  const withMentions = {
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(formatting.length > 0 ? { formatting } : {}),
  };
  return { conversationId, body, files, withMentions };
}

async function sendCurrent() {
  const prepared = prepareCompose();
  if (!prepared) {
    return;
  }
  const { conversationId, body, files, withMentions } = prepared;
  $('send').disabled = true;
  $('send-error').hidden = true;
  // As Signal: sending goes back to the newest messages.
  if (newerCursor !== null) {
    await showLatest();
  }
  try {
    if (editing) {
      await api('api/edit', { messageId: editing.id, body, ...withMentions });
      cancelReply();
      setCompose('');
      return;
    }
    const attachmentUploadIds = [];
    for (const [i, draft] of files.entries()) {
      $('send').textContent =
        files.length > 1 ? `${i + 1}/${files.length}` : '…';
      // oxlint-disable-next-line no-await-in-loop
      attachmentUploadIds.push(await uploadFile(draft.file));
    }
    const { message } = await api('api/send', {
      conversationId,
      body,
      ...withMentions,
      ...(replyTo ? { quoteMessageId: replyTo.id } : {}),
      ...(replyTo?.privateFrom
        ? { privateReplyFrom: replyTo.privateFrom }
        : {}),
      ...(attachmentUploadIds.length > 0 ? { attachmentUploadIds } : {}),
      ...(composePreview?.url && attachmentUploadIds.length === 0
        ? { linkPreviewUrl: composePreview.url }
        : {}),
    });
    resetLinkPreview();
    if (replyTo?.privateFrom) {
      addPrivateLink({
        groupConversationId: replyTo.privateFrom,
        groupMessageId: replyTo.id,
        dmConversationId: conversationId,
        replyMessageId: message.id,
      });
    }
    clearDrafts(conversationId);
    setCompose('');
    cancelReply();
    // Events can get here first with a newer status (Sent); keep that.
    if (!messages.has(message.id)) {
      putMessage(message);
    }
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`
    );
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Send';
    focusCompose();
  }
}

// --- scheduled messages (decision F29) ------------------------------------------

// Signal Desktop can't schedule; the helper keeps scheduled messages and
// sends them through Signal when they come due. As Signal on Android: hold
// (or right-click) Send to schedule; a clock by Send lists the chat's.
let scheduledCounts = {};
let scheduledItems = [];
// { id } while a scheduled message is being moved to a new time.
let rescheduling = null;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatScheduleTime(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((d - start) / DAY_MS);
  if (days === 0) {
    return `Today, ${time}`;
  }
  if (days === 1) {
    return `Tomorrow, ${time}`;
  }
  const date = d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === start.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

// Signal Android's choices: this evening, tomorrow morning, next Monday.
function schedulePresets(now = new Date()) {
  const at = (days, hour) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const presets = [];
  if (now.getHours() < 17) {
    presets.push(at(0, 18));
  } else if (now.getHours() < 20) {
    presets.push(at(0, 21));
  }
  presets.push(at(1, 8));
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) {
    presets.push(at(toMonday, 8));
  }
  return presets;
}

function localInputValue(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

function openSchedule(item = null) {
  if (!item) {
    if (editing) {
      return;
    }
    if (replyTo?.privateFrom) {
      toast("A private reply can't be scheduled.");
      return;
    }
    if (!prepareCompose()) {
      toast('Write a message first, then hold Send to schedule it.');
      return;
    }
  }
  rescheduling = item ? { id: item.id } : null;
  $('schedule-title').textContent = item
    ? 'Reschedule message'
    : 'Schedule message';
  $('schedule-options').replaceChildren(
    ...schedulePresets().map(at => {
      const option = el('button', 'schedule-option', formatScheduleTime(at));
      option.type = 'button';
      option.addEventListener('click', () => pickScheduleTime(at));
      return option;
    })
  );
  const now = Date.now();
  const input = $('schedule-at');
  input.min = localInputValue(now);
  // An hour from now, on the quarter hour.
  const suggested =
    item?.sendAt > now
      ? item.sendAt
      : Math.ceil((now + 60 * 60 * 1000) / (15 * 60 * 1000)) * 15 * 60 * 1000;
  input.value = localInputValue(suggested);
  $('schedule-send').disabled = false;
  $('schedule').hidden = false;
  $('schedule-options').querySelector('button')?.focus();
}

function closeSchedule() {
  rescheduling = null;
  $('schedule').hidden = true;
}

async function pickScheduleTime(sendAt) {
  if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
    toast('Pick a time in the future.');
    return;
  }
  for (const b of $('schedule').querySelectorAll('button')) {
    b.disabled = true;
  }
  try {
    if (rescheduling) {
      await api('api/scheduled/update', { id: rescheduling.id, sendAt });
      toast(`Rescheduled for ${formatScheduleTime(sendAt)}`);
    } else {
      await scheduleCurrent(sendAt);
    }
    closeSchedule();
  } catch (error) {
    toast(`Not scheduled (${error.code ?? error.message}).`);
  } finally {
    for (const b of $('schedule').querySelectorAll('button')) {
      b.disabled = false;
    }
  }
}

async function saveScheduledFile(file) {
  const params = new URLSearchParams({
    contentType: file.type || 'application/octet-stream',
    ...(file.name ? { name: file.name } : {}),
  });
  const res = await fetch(`api/scheduleFile?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code ?? `HTTP ${res.status}`;
    throw error;
  }
  return data;
}

async function scheduleCurrent(sendAt) {
  const prepared = prepareCompose();
  if (!prepared) {
    return;
  }
  const { conversationId, body, files, withMentions } = prepared;
  const saved = [];
  for (const draft of files) {
    // oxlint-disable-next-line no-await-in-loop
    saved.push(await saveScheduledFile(draft.file));
  }
  await api('api/schedule', {
    conversationId,
    sendAt,
    body,
    ...withMentions,
    ...(replyTo ? { quoteMessageId: replyTo.id } : {}),
    ...(composePreview?.url && saved.length === 0
      ? { linkPreviewUrl: composePreview.url }
      : {}),
    files: saved,
  });
  resetLinkPreview();
  clearDrafts(conversationId);
  setCompose('');
  cancelReply();
  toast(`Scheduled for ${formatScheduleTime(sendAt)}`);
}

function renderScheduledButton() {
  const count = (selectedId && scheduledCounts[selectedId]) || 0;
  const button = $('scheduled-open');
  button.hidden = count === 0;
  $('scheduled-count').textContent = count > 1 ? String(count) : '';
  const label =
    count === 1 ? '1 scheduled message' : `${count} scheduled messages`;
  button.title = label;
  button.setAttribute('aria-label', label);
}

async function loadScheduled() {
  const params = new URLSearchParams({ conversationId: selectedId ?? '' });
  const { items, counts } = await api(`api/scheduled?${params}`);
  scheduledCounts = counts;
  scheduledItems = selectedId ? items : [];
  renderScheduledButton();
  if (!$('scheduled').hidden) {
    renderScheduledList();
  }
}

// The text as it will read: mentions by name.
function scheduledText(item) {
  const at = new Map(item.mentions.map(m => [m.start, m.conversationId]));
  let text = '';
  for (let i = 0; i < item.body.length; i += 1) {
    text += at.has(i) ? `@${nameOf(at.get(i))}` : item.body[i];
  }
  return text.trim();
}

function renderScheduledList() {
  const list = $('scheduled-list');
  if (scheduledItems.length === 0) {
    closeScheduledList();
    return;
  }
  list.replaceChildren(
    ...scheduledItems.map(item => {
      const li = el('li', item.failed ? 'failed' : '');
      const when = el('div', 'scheduled-when', formatScheduleTime(item.sendAt));
      if (item.failed) {
        when.append(
          el('span', 'scheduled-failed', ` · Not sent (${item.failed})`)
        );
      }
      const files =
        item.files.length === 0
          ? ''
          : item.files.length === 1
            ? (item.files[0].fileName ?? '1 file')
            : `${item.files.length} files`;
      const text = scheduledText(item);
      li.append(
        when,
        el('div', 'scheduled-text', text || files),
        ...(text && files ? [el('div', 'scheduled-files sub', files)] : [])
      );
      const actions = el('div', 'scheduled-actions');
      const action = (label, onClick, className = 'secondary') => {
        const b = el('button', className, label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await onClick();
          } catch (error) {
            toast(`Failed (${error.code ?? error.message}).`);
          } finally {
            b.disabled = false;
          }
        });
        return b;
      };
      actions.append(
        action('Delete', () => api('api/scheduled/delete', { id: item.id })),
        action('Reschedule', () => openSchedule(item)),
        action(
          'Send now',
          () => api('api/scheduled/sendNow', { id: item.id }),
          ''
        )
      );
      li.append(actions);
      return li;
    })
  );
}

async function openScheduledList() {
  $('scheduled').hidden = false;
  try {
    await loadScheduled();
  } catch {
    // The list shows what it had.
  }
  renderScheduledList();
}

function closeScheduledList() {
  $('scheduled').hidden = true;
}

// --- message box: mentions and formatting ----------------------------------------

// The box is editable HTML so it can show styles and mentions as Signal's
// does. What it holds is read back as a list of characters, each with its
// styles and, for a mention, who it names; that list is what gets sent.
const MENTION_PLACEHOLDER = '￼';
const STYLES = ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'];
const STYLE_LABEL = {
  bold: 'Bold',
  italic: 'Italic',
  strikethrough: 'Strikethrough',
  monospace: 'Monospace',
  spoiler: 'Spoiler',
};
// Signal's own shortcuts (ts/quill/formatting/menu.dom.tsx).
const STYLE_SHORTCUT = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  strikethrough: 'Ctrl+Shift+X',
  monospace: 'Ctrl+E',
  spoiler: 'Ctrl+Shift+B',
};
// The menu and the bar: Signal's styles, plus bold italic in one step (two
// ranges over the same text, as Signal itself sends it).
const FORMAT_OPTIONS = [
  { key: 'bold', styles: ['bold'] },
  { key: 'italic', styles: ['italic'] },
  { key: 'bolditalic', styles: ['bold', 'italic'], label: 'Bold Italic' },
  { key: 'strikethrough', styles: ['strikethrough'] },
  { key: 'monospace', styles: ['monospace'] },
  { key: 'spoiler', styles: ['spoiler'] },
].map(o => ({
  label: STYLE_LABEL[o.key],
  shortcut: STYLE_SHORTCUT[o.key] ?? '',
  ...o,
}));
const CLASS_STYLE = Object.fromEntries(
  Object.entries(STYLE_CLASS).map(([style, cls]) => [cls, style])
);
const TAG_STYLE = {
  B: 'bold',
  STRONG: 'bold',
  I: 'italic',
  EM: 'italic',
  S: 'strikethrough',
  STRIKE: 'strikethrough',
  DEL: 'strikethrough',
  CODE: 'monospace',
};
// The last selection in the box, as character offsets; the emoji picker
// takes the focus away and still inserts here.
let composeSelection = null;
// conversationId -> Promise of [{ conversationId, author }]
const memberCache = new Map();
let mentionQuery = null;
let mentionChoices = [];
let mentionIndex = 0;

// The forward dialog's box while that dialog is open (decision F32).
let composeTarget = null;

function composeBox() {
  return composeTarget ?? $('compose');
}

// [{ ch, styles: Set, mention?: { conversationId, title } }]
function readNodes(root, { dropPlaceholder }) {
  const chars = [];
  const leaves = [];
  const walk = (node, styles) => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.data.replaceAll(MENTION_PLACEHOLDER, '')) {
        chars.push({ ch: ch === ' ' ? ' ' : ch, styles });
      }
      leaves.push(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    if (node.tagName === 'BR') {
      chars.push({ ch: '\n', styles });
      leaves.push(node);
      return;
    }
    if (node.dataset.cid) {
      chars.push({
        ch: MENTION_PLACEHOLDER,
        styles,
        mention: {
          conversationId: node.dataset.cid,
          title: node.dataset.title,
        },
      });
      leaves.push(node);
      return;
    }
    let inner = styles;
    const add = [
      TAG_STYLE[node.tagName],
      ...[...node.classList].map(cls => CLASS_STYLE[cls]),
    ].filter(Boolean);
    if (add.length > 0) {
      inner = new Set([...styles, ...add]);
    }
    const block = node !== root && /^(DIV|P|LI)$/.test(node.tagName);
    if (block && chars.length > 0 && chars.at(-1).ch !== '\n') {
      chars.push({ ch: '\n', styles: new Set() });
    }
    for (const child of node.childNodes) {
      walk(child, inner);
    }
  };
  walk(root, new Set());
  // A <br> at the very end only holds the caret on an empty last line.
  if (dropPlaceholder && leaves.at(-1)?.nodeName === 'BR') {
    chars.pop();
  }
  return chars;
}

function readCompose() {
  return readNodes(composeBox(), { dropPlaceholder: true });
}

// Where a DOM point falls, counted in characters.
function offsetAt(container, offset) {
  const box = composeBox();
  const range = document.createRange();
  range.setStart(box, 0);
  range.setEnd(container, offset);
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  return readNodes(holder, { dropPlaceholder: false }).length;
}

function selectionOffsets() {
  const box = composeBox();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return null;
  }
  const range = sel.getRangeAt(0);
  if (
    !box.contains(range.startContainer) ||
    !box.contains(range.endContainer)
  ) {
    return null;
  }
  const a = offsetAt(range.startContainer, range.startOffset);
  const b = offsetAt(range.endContainer, range.endOffset);
  const length = readCompose().length;
  return { start: Math.min(a, length), end: Math.min(b, length) };
}

// The DOM point for a character offset, in a box this code drew.
function pointAt(target) {
  const box = composeBox();
  let at = 0;
  const leaves = [];
  const walk = node => {
    if (
      node.nodeType === Node.TEXT_NODE ||
      node.nodeName === 'BR' ||
      node.dataset?.cid
    ) {
      leaves.push(node);
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(box);
  for (const leaf of leaves) {
    if (leaf.nodeType === Node.TEXT_NODE) {
      // Offsets here count characters; the DOM counts UTF-16 units.
      const cps = [...leaf.data];
      if (target <= at + cps.length) {
        return [leaf, cps.slice(0, target - at).join('').length];
      }
      at += cps.length;
    } else {
      if (target <= at) {
        return [leaf.parentNode, [...leaf.parentNode.childNodes].indexOf(leaf)];
      }
      at += 1;
    }
  }
  return [box, box.childNodes.length];
}

function selectOffsets(start, end = start) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(...pointAt(start));
  range.setEnd(...pointAt(end));
  sel.removeAllRanges();
  sel.addRange(range);
  composeSelection = { start, end };
}

function styleKey(styles) {
  return STYLES.filter(s => styles.has(s)).join(' ');
}

// Draws the characters back into the box: one span per run of styles.
function drawCompose(chars) {
  const box = composeBox();
  const nodes = [];
  let run = null;
  let runKey = null;
  const holder = styles => {
    const key = styleKey(styles);
    if (key === '') {
      run = null;
      runKey = null;
      return null;
    }
    if (run && runKey === key) {
      return run;
    }
    run = el(
      'span',
      STYLES.filter(s => styles.has(s))
        .map(s => STYLE_CLASS[s])
        .join(' ')
    );
    runKey = key;
    nodes.push(run);
    return run;
  };
  const put = (parent, node) => {
    if (parent) {
      parent.append(node);
    } else {
      nodes.push(node);
    }
  };
  let text = '';
  let textStyles = null;
  const flush = () => {
    if (text) {
      put(holder(textStyles), document.createTextNode(text));
      text = '';
    }
  };
  for (const c of chars) {
    if (c.mention) {
      flush();
      const pill = el('span', 'mention', `@${c.mention.title ?? 'Someone'}`);
      pill.contentEditable = 'false';
      pill.dataset.cid = c.mention.conversationId;
      pill.dataset.title = c.mention.title ?? 'Someone';
      put(holder(c.styles), pill);
    } else if (c.ch === '\n') {
      flush();
      run = null;
      runKey = null;
      nodes.push(el('br'));
    } else {
      if (textStyles && styleKey(textStyles) !== styleKey(c.styles)) {
        flush();
      }
      textStyles = c.styles;
      text += c.ch;
    }
  }
  flush();
  if (chars.at(-1)?.ch === '\n') {
    nodes.push(el('br'));
  }
  box.replaceChildren(...nodes);
}

function charsOf(text, styles = new Set()) {
  return [
    ...text.replaceAll(MENTION_PLACEHOLDER, '').replace(/\r\n?/g, '\n'),
  ].map(ch => ({ ch, styles }));
}

// Messages hold U+FFFC where a mention is, plus ranges for styles.
function setCompose(text, mentions = [], formatting = []) {
  const byStart = new Map(mentions.map(m => [m.start, m]));
  const chars = [];
  let i = 0;
  for (const ch of text) {
    const styles = new Set(
      formatting
        .filter(r => r.start <= i && i < r.start + r.length)
        .map(r => r.style)
        .filter(s => STYLES.includes(s))
    );
    const mention = byStart.get(i);
    if (ch === MENTION_PLACEHOLDER && mention?.conversationId) {
      chars.push({
        ch,
        styles,
        mention: {
          conversationId: mention.conversationId,
          title: mention.title ?? 'Someone',
        },
      });
    } else if (ch === MENTION_PLACEHOLDER) {
      // A mention of someone the page can't name again: keep the words.
      chars.push(...charsOf(`@${mention?.title ?? 'Someone'}`, styles));
    } else {
      chars.push({ ch, styles });
    }
    i += ch.length;
  }
  drawCompose(chars);
  composeSelection = null;
  scheduleLinkPreview();
}

// Replaces start..end with the given characters, then puts the caret after.
function spliceCompose(start, end, inserted) {
  const chars = readCompose();
  chars.splice(start, end - start, ...inserted);
  drawCompose(chars);
  composeBox().focus();
  selectOffsets(start + inserted.length);
}

function insertPlain(text) {
  const at = selectionOffsets() ?? composeSelection;
  const length = readCompose().length;
  const start = at?.start ?? length;
  const end = at?.end ?? length;
  // Unicode-styled text comes in as Signal's styles (decision F33).
  spliceCompose(start, end, charsFromUnicode(text));
  onComposeInput();
}

// The body as Signal wants it: U+FFFC for each mention, and style ranges.
function composeForSend() {
  const chars = readCompose();
  // Ranges count UTF-16 units, as Signal's do.
  let body = '';
  const mentions = [];
  const formatting = [];
  const open = new Map();
  const units = [];
  for (const c of chars) {
    if (c.mention) {
      mentions.push({
        start: body.length,
        conversationId: c.mention.conversationId,
      });
    }
    units.push({ start: body.length, styles: c.styles });
    body += c.ch;
  }
  units.push({ start: body.length, styles: new Set() });
  for (const unit of units) {
    for (const style of STYLES) {
      if (unit.styles.has(style) && !open.has(style)) {
        open.set(style, unit.start);
      } else if (!unit.styles.has(style) && open.has(style)) {
        const start = open.get(style);
        formatting.push({ start, length: unit.start - start, style });
        open.delete(style);
      }
    }
  }
  return { body, mentions, formatting };
}

// Bold and the rest (or several at once): on for the whole selection
// unless all of it has them.
function toggleStyle(style) {
  const wanted = [style].flat();
  const at = selectionOffsets();
  if (!at || at.start === at.end) {
    return;
  }
  const chars = readCompose();
  const on = !selectionHas(wanted);
  for (let i = at.start; i < at.end; i += 1) {
    const styles = new Set(chars[i].styles);
    for (const one of wanted) {
      if (on) {
        styles.add(one);
      } else {
        styles.delete(one);
      }
    }
    chars[i] = { ...chars[i], styles };
  }
  drawCompose(chars);
  composeBox().focus();
  selectOffsets(at.start, at.end);
  updateFormatBar();
}

function selectionHas(style) {
  const wanted = [style].flat();
  const at = selectionOffsets();
  if (!at || at.start === at.end) {
    return false;
  }
  return readCompose()
    .slice(at.start, at.end)
    .every(c => wanted.every(one => c.styles.has(one)));
}

// Mentions name members of one chat; elsewhere they become plain words.
function dropComposeMentions() {
  const chars = readCompose();
  if (!chars.some(c => c.mention)) {
    return;
  }
  drawCompose(
    chars.flatMap(c =>
      c.mention ? charsOf(`@${c.mention.title}`, c.styles) : [c]
    )
  );
}

function focusCompose({ end = false } = {}) {
  const box = composeBox();
  box.focus();
  if (end || !selectionOffsets()) {
    selectOffsets(readCompose().length);
  }
}

// Keeps the empty box truly empty, so the placeholder shows.
// Signal's typing dots.
function typingDots() {
  const dots = el('span', 'typing-dots');
  dots.setAttribute('role', 'img');
  dots.setAttribute('aria-label', 'Typing');
  dots.append(el('span'), el('span'), el('span'));
  return dots;
}

// As Signal's timeline: a bubble with the dots under the last message, with
// the typists' photos in groups.
function renderTyping() {
  const box = $('typing');
  const typists = typingIn.get(selectedId) ?? [];
  if (typists.length === 0) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const messagesBox = $('messages');
  const atBottom =
    messagesBox.scrollHeight -
      messagesBox.scrollTop -
      messagesBox.clientHeight <
    80;
  const conversation = conversations.get(selectedId);
  const row = el('div', 'typing-row');
  if (conversation?.type === 'group') {
    const faces = el('span', 'typing-avatars');
    for (const t of typists.slice(0, 3)) {
      faces.append(
        avatar(
          t.authorConversationId,
          t.author ?? authorOf(t.authorConversationId) ?? { title: '' },
          28
        )
      );
    }
    row.append(faces);
  }
  const bubble = el('span', 'bubble typing-bubble');
  bubble.append(typingDots());
  row.append(bubble);
  const names = typists
    .map(t => (t.author ?? authorOf(t.authorConversationId))?.title)
    .filter(Boolean);
  row.title = names.length ? `${names.join(', ')} typing` : 'Typing';
  box.replaceChildren(row);
  box.hidden = false;
  if (atBottom) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
}

// Tells Signal we're typing, at most once a second; Signal itself refreshes,
// pauses after three seconds and honors the typing indicators setting.
let typingSentAt = 0;
let typingFor = null;

function sendTyping(typing) {
  if (!capabilities.includes('typing.send') || !selectedId) {
    return;
  }
  const now = Date.now();
  if (typing) {
    if (typingFor === selectedId && now - typingSentAt < 1000) {
      return;
    }
    typingSentAt = now;
    typingFor = selectedId;
  } else {
    if (typingFor !== selectedId) {
      return;
    }
    typingFor = null;
  }
  api('api/typing', { conversationId: selectedId, typing }).catch(() => {});
}

function onComposeInput() {
  if (composeTarget) {
    onForwardInput();
    return;
  }
  const box = composeBox();
  if (box.childNodes.length > 0 && readCompose().length === 0) {
    box.replaceChildren();
  }
  sendTyping(box.childNodes.length > 0);
  updateMentionPicker();
  updateFormatBar();
  scheduleLinkPreview();
}

// --- link previews in the composer (Signal fetches them) ---------------------

// { url, title, description, domain, image } once Signal has one for the
// draft's first link; `loading` while it fetches.
let composePreview = null;
// Links whose preview the user removed, until the message is sent.
let dismissedPreviews = new Set();
let previewTimer = null;
let previewSeq = 0;
const URL_HINT = /https?:\/\/\S/i;

function scheduleLinkPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateLinkPreview, 300);
}

function resetLinkPreview() {
  clearTimeout(previewTimer);
  previewSeq += 1;
  composePreview = null;
  dismissedPreviews = new Set();
  renderLinkPreviewBar();
}

async function updateLinkPreview() {
  // The forward dialog's box isn't the message box (decision F32).
  if (composeTarget) {
    return;
  }
  const seq = ++previewSeq;
  const text = composeForSend().body;
  // As Signal: no link preview with attachments, or while editing.
  if (
    !selectedId ||
    editing ||
    draftsFor(selectedId).length > 0 ||
    !URL_HINT.test(text)
  ) {
    composePreview = null;
    renderLinkPreviewBar();
    return;
  }
  if (composePreview && text.includes(composePreview.url)) {
    return;
  }
  composePreview = { loading: true };
  renderLinkPreviewBar();
  let preview = null;
  try {
    ({ preview } = await api('api/linkPreview', {
      text,
      exclude: [...dismissedPreviews],
    }));
  } catch {
    preview = null;
  }
  if (seq !== previewSeq) {
    return;
  }
  composePreview = preview;
  renderLinkPreviewBar();
}

let previewImageUrl = null;

function renderLinkPreviewBar() {
  const bar = $('compose-preview');
  const card = $('compose-preview-card');
  if (previewImageUrl) {
    URL.revokeObjectURL(previewImageUrl);
    previewImageUrl = null;
  }
  bar.hidden = !composePreview;
  if (!composePreview) {
    card.replaceChildren();
    return;
  }
  if (composePreview.loading) {
    card.replaceChildren(
      el('span', 'compose-preview-loading', 'Loading preview…')
    );
    return;
  }
  const p = composePreview;
  const parts = [];
  if (p.image) {
    const img = el('img', 'compose-preview-image');
    img.alt = '';
    // The page's CSP allows blob: images, not data: ones.
    const bytes = Uint8Array.from(atob(p.image.data), c => c.charCodeAt(0));
    previewImageUrl = URL.createObjectURL(
      new Blob([bytes], { type: p.image.contentType })
    );
    img.src = previewImageUrl;
    parts.push(img);
  }
  const text = el('span', 'link-preview-text');
  if (p.title) {
    text.append(el('span', 'link-preview-title', p.title));
  }
  if (p.description) {
    text.append(el('span', 'link-preview-description', p.description));
  }
  text.append(el('span', 'link-preview-domain', p.domain ?? p.url));
  parts.push(text);
  card.replaceChildren(...parts);
}

function dismissLinkPreview() {
  if (composePreview?.url) {
    dismissedPreviews.add(composePreview.url);
  }
  previewSeq += 1;
  composePreview = null;
  renderLinkPreviewBar();
  // Signal then offers the next link in the message, if there is one.
  scheduleLinkPreview();
  focusCompose();
}

// --- voice notes (Signal's recorder) ------------------------------------------

// Signal stops a recording at one hour.
const MAX_RECORDING_MS = 60 * 60_000;
const MAX_PEAK_BARS = 120;
let encoderContext = null;
// { conversationId, stream, source, worklet, chunks, startedAt, peaks,
//   timer, done } while recording; then { conversationId, blob, url,
//   durationSeconds, waveform } as a draft waiting to be sent.
let recording = null;
let voiceDraft = null;

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

async function getEncoderContext() {
  if (!encoderContext) {
    const context = new AudioContext();
    encoderContext = context.audioWorklet
      .addModule('mp3Encoder.js')
      .then(() => context)
      .catch(error => {
        encoderContext = null;
        context.close().catch(() => {});
        throw error;
      });
  }
  return encoderContext;
}

function showRecorder(mode) {
  const on = mode !== null;
  $('composer').classList.toggle('recording', on);
  $('recorder').hidden = !on;
  $('recorder').dataset.mode = mode ?? '';
  $('record-dot').hidden = mode !== 'recording';
  $('record-peaks').hidden = mode !== 'recording';
  $('record-audio').hidden = mode !== 'draft';
  $('record-time').hidden = mode !== 'recording';
}

function renderPeaks() {
  const bars = recording.peaks
    .slice(-MAX_PEAK_BARS)
    .reverse()
    .map(peak => {
      const bar = el('b');
      bar.style.height = `${Math.max(8, (peak / 255) * 100)}%`;
      return bar;
    });
  $('record-peaks').replaceChildren(...bars);
}

async function startRecording() {
  if (recording || voiceDraft || !selectedId) {
    return;
  }
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    toast("This browser can't record voice messages.");
    return;
  }
  const conversationId = selectedId;
  let context;
  try {
    context = await getEncoderContext();
  } catch {
    toast('Voice messages need the encoder from the Signal image.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: { ideal: 1 } },
    });
  } catch (error) {
    // Rambox shows no permission prompt, so say what refused it.
    const hint =
      error?.name === 'NotFoundError'
        ? 'No microphone found on this computer.'
        : error?.name === 'NotReadableError'
          ? 'The microphone is in use by another app or blocked by the system.'
          : error?.name === 'NotAllowedError'
            ? 'The microphone was refused. On Windows, check Settings > Privacy & security > Microphone, including "Let desktop apps access your microphone".'
            : `Couldn't open the microphone.`;
    toast(`${hint} (${error?.name ?? error})`);
    return;
  }
  if (conversationId !== selectedId) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }
  await context.resume();
  // As Signal's AudioRecorder: the encoder sends MP3 chunks, then the final
  // frame and the header with the full duration.
  const worklet = new AudioWorkletNode(context, 'mp3-encoder', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  const chunks = [];
  const { promise: done, resolve } = Promise.withResolvers();
  const state = {
    conversationId,
    stream,
    worklet,
    chunks,
    startedAt: Date.now(),
    peaks: [],
    timer: null,
    done,
  };
  worklet.port.onmessage = ({ data }) => {
    if (data.type === 'chunk') {
      chunks.push(data.chunk);
    } else if (data.type === 'peak') {
      state.peaks.push(data.peak);
      if (recording === state) {
        renderPeaks();
      }
    } else if (data.type === 'complete') {
      chunks.push(data.finalFrame);
      resolve(data);
    }
  };
  state.source = context.createMediaStreamSource(stream);
  state.source.connect(worklet);
  state.timer = setInterval(() => {
    const elapsed = Date.now() - state.startedAt;
    $('record-time').textContent = formatDuration(elapsed / 1000);
    if (elapsed >= MAX_RECORDING_MS) {
      // As Signal: stopped at the limit, kept for you to send or discard.
      toast('Voice message recording stopped at the maximum length.');
      stopRecording({ send: false });
    }
  }, 250);
  recording = state;
  sendTyping(false);
  $('record-time').textContent = '0:00';
  $('record-peaks').replaceChildren();
  showRecorder('recording');
}

// Ends the recording. Returns the voice note, or null if it was discarded.
async function finishRecording() {
  const state = recording;
  if (!state) {
    return null;
  }
  recording = null;
  clearInterval(state.timer);
  state.worklet.port.postMessage({ type: 'stop' });
  const result = await state.done;
  state.source.disconnect();
  state.stream.getTracks().forEach(track => track.stop());
  const total = state.chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  // The header with the full duration replaces the placeholder.
  bytes.set(result.lametagFrame);
  return {
    conversationId: state.conversationId,
    blob: new Blob([bytes], { type: 'audio/mpeg' }),
    durationSeconds: result.duration,
    waveform: result.waveform,
  };
}

async function stopRecording({ send }) {
  const note = await finishRecording();
  if (!note) {
    return;
  }
  if (send) {
    showRecorder(null);
    await sendVoiceNote(note);
    return;
  }
  // Kept as a draft, as Signal does when you switch away.
  voiceDraft = { ...note, url: URL.createObjectURL(note.blob) };
  $('record-audio').src = voiceDraft.url;
  showRecorder('draft');
}

// The draft shows only in its own chat.
function renderVoiceDraft() {
  if (recording) {
    return;
  }
  showRecorder(
    voiceDraft && voiceDraft.conversationId === selectedId ? 'draft' : null
  );
}

function discardVoiceDraft() {
  if (voiceDraft) {
    URL.revokeObjectURL(voiceDraft.url);
    voiceDraft = null;
    $('record-audio').removeAttribute('src');
  }
}

async function cancelRecording() {
  await finishRecording();
  discardVoiceDraft();
  showRecorder(null);
}

async function sendVoiceDraft() {
  const note = voiceDraft;
  if (!note) {
    return;
  }
  voiceDraft = null;
  showRecorder(null);
  await sendVoiceNote(note);
  URL.revokeObjectURL(note.url);
  $('record-audio').removeAttribute('src');
}

async function sendVoiceNote(note) {
  const quoteMessageId =
    replyTo && note.conversationId === selectedId ? replyTo.id : undefined;
  try {
    const params = new URLSearchParams({
      contentType: 'audio/mpeg',
      voiceNote: JSON.stringify({
        durationSeconds: note.durationSeconds,
        waveform: note.waveform,
      }),
    });
    const res = await fetch(`api/upload?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: note.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
      error.code = data.error?.code;
      throw error;
    }
    await api('api/send', {
      conversationId: note.conversationId,
      body: '',
      attachmentUploadIds: [data.uploadId],
      ...(quoteMessageId ? { quoteMessageId } : {}),
    });
    if (quoteMessageId) {
      cancelReply();
    }
  } catch (error) {
    showError(
      `Couldn't send the voice message (${error.code ?? error.message}).`
    );
  }
}

// --- format bar and menu -------------------------------------------------------

function styleButton(option, onClick) {
  const b = el('button', `format-button fb-${option.key}`);
  b.type = 'button';
  b.title = option.shortcut
    ? `${option.label} (${option.shortcut})`
    : option.label;
  b.setAttribute('aria-label', option.label);
  b.append(
    el(
      'span',
      option.styles.map(style => STYLE_CLASS[style]).join(' '),
      option.styles.map(style => STYLE_LABEL[style][0]).join('')
    )
  );
  b.addEventListener('mousedown', e => {
    // Keep the selection in the box.
    e.preventDefault();
  });
  b.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function updateFormatBar() {
  const bar = $('format-bar');
  const box = composeBox();
  const at = document.activeElement === box ? selectionOffsets() : null;
  if (!at || at.start === at.end || !$('format-menu').hidden) {
    bar.hidden = true;
    return;
  }
  if (bar.childElementCount === 0) {
    bar.append(
      ...FORMAT_OPTIONS.map(option =>
        styleButton(option, () => toggleStyle(option.styles))
      )
    );
  }
  for (const option of FORMAT_OPTIONS) {
    bar
      .querySelector(`.fb-${option.key}`)
      .classList.toggle('active', selectionHas(option.styles));
  }
  bar.hidden = false;
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - b.width / 2),
    window.innerWidth - b.width - 8
  );
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.max(8, rect.top - b.height - 8)}px`;
}

async function pasteFromClipboard() {
  try {
    insertPlain(await navigator.clipboard.readText());
  } catch {
    toast('Press Ctrl+V to paste.');
  }
}

// Right-click on selected text: Signal's styles, plus cut, copy and paste.
// Shift+right-click still gives the browser's own menu.
function openFormatMenu(x, y) {
  closePopovers();
  const menu = $('format-menu');
  const item = (label, shortcut, action, checked = null) => {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', checked === null ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== null) {
      b.setAttribute('aria-checked', String(checked));
    }
    b.append(
      el('span', 'format-check', checked ? '✓' : ''),
      el('span', 'format-label', label),
      el('span', 'format-shortcut', shortcut)
    );
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeFormatMenu();
      action();
    });
    return b;
  };
  menu.replaceChildren(
    item('Cut', 'Ctrl+X', () => document.execCommand('cut')),
    item('Copy', 'Ctrl+C', () => document.execCommand('copy')),
    item('Paste', 'Ctrl+V', () => pasteFromClipboard()),
    el('div', 'menu-separator'),
    ...FORMAT_OPTIONS.map(option =>
      item(
        option.label,
        option.shortcut,
        () => toggleStyle(option.styles),
        selectionHas(option.styles)
      )
    )
  );
  $('format-bar').hidden = true;
  menu.hidden = false;
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - m.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - m.height - 8))}px`;
}

function closeFormatMenu() {
  $('format-menu').hidden = true;
}

// --- @mentions -----------------------------------------------------------------

function loadMembers(conversationId) {
  if (!memberCache.has(conversationId)) {
    const params = new URLSearchParams({ conversationId });
    const request = api(`api/members?${params}`)
      .then(({ members }) => members)
      .catch(() => {
        memberCache.delete(conversationId);
        return [];
      });
    memberCache.set(conversationId, request);
  }
  return memberCache.get(conversationId);
}

function fold(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// As Signal's list: a name matches when one of its words starts with what
// was typed after the @.
function matchesMention(member, query) {
  if (!query) {
    return true;
  }
  const q = fold(query);
  const title = fold(member.author.title);
  return title.startsWith(q) || title.split(/\s+/).some(w => w.startsWith(q));
}

// The "@query" right before the caret, if the caret is in one.
function mentionTrigger() {
  if (document.activeElement !== composeBox()) {
    return null;
  }
  const at = selectionOffsets();
  if (!at || at.start !== at.end) {
    return null;
  }
  const before = readCompose()
    .slice(0, at.start)
    .map(c => c.ch)
    .join('');
  const match = /(^|\s)@([^\s@￼]{0,40})$/u.exec(before);
  if (!match) {
    return null;
  }
  const length = [...match[2]].length;
  return { start: at.start - length - 1, end: at.start, query: match[2] };
}

// The groups whose members can be mentioned: the chat's, or in the forward
// dialog every group picked (decision F32).
function mentionGroups() {
  const ids = composeTarget ? [...forwardSelected] : [selectedId];
  return ids.filter(id => conversations.get(id)?.type === 'group');
}

async function updateMentionPicker() {
  const groups = mentionGroups();
  const trigger = groups.length > 0 ? mentionTrigger() : null;
  if (!trigger) {
    closeMentionPicker();
    return;
  }
  const lists = await Promise.all(groups.map(loadMembers));
  const now = mentionTrigger();
  if (
    mentionGroups().join() !== groups.join() ||
    !now ||
    now.query !== trigger.query
  ) {
    return;
  }
  const members = [
    ...new Map(lists.flat().map(m => [m.conversationId, m])).values(),
  ].sort((a, b) => a.author.title.localeCompare(b.author.title));
  mentionQuery = now;
  // Everyone who matches, as Signal lists them; the list scrolls.
  mentionChoices = members.filter(m => matchesMention(m, now.query));
  mentionIndex = 0;
  renderMentionPicker();
}

function renderMentionPicker() {
  const picker = $('mention-picker');
  if (mentionChoices.length === 0) {
    closeMentionPicker();
    return;
  }
  picker.replaceChildren(
    ...mentionChoices.map((member, i) => {
      const row = el(
        'div',
        `mention-row${i === mentionIndex ? ' active' : ''}`
      );
      row.setAttribute('role', 'option');
      row.append(
        avatar(member.conversationId, member.author, 28),
        el('span', 'mention-name', member.author.title)
      );
      row.addEventListener('mousedown', e => {
        // Keep the focus in the message box.
        e.preventDefault();
        pickMention(member);
      });
      return row;
    })
  );
  picker.hidden = false;
  const box = composeBox().getBoundingClientRect();
  picker.style.left = `${box.left}px`;
  picker.style.width = `${Math.min(box.width, 360)}px`;
  picker.style.top = `${Math.max(8, box.top - picker.offsetHeight - 6)}px`;
  picker.children[mentionIndex]?.scrollIntoView({ block: 'nearest' });
}

function closeMentionPicker() {
  mentionQuery = null;
  mentionChoices = [];
  $('mention-picker').hidden = true;
}

function pickMention(member) {
  const trigger = mentionQuery ?? mentionTrigger();
  if (!trigger) {
    return;
  }
  closeMentionPicker();
  spliceCompose(trigger.start, trigger.end, [
    {
      ch: MENTION_PLACEHOLDER,
      styles: new Set(),
      mention: {
        conversationId: member.conversationId,
        title: member.author.title,
      },
    },
    { ch: ' ', styles: new Set() },
  ]);
}

// --- styled text: markdown shortcuts and Unicode copies (decision F33) -----------

// Typing *bold*, _italic_, ~strikethrough~ or `monospace` applies Signal's
// own style as the closing mark goes in; nested marks combine, so _*both*_
// is bold italic. Backspace right after takes it back to the typed marks.
const MARKDOWN_STYLE = {
  '*': 'bold',
  _: 'italic',
  '~': 'strikethrough',
  '`': 'monospace',
};
const WORD_CHAR = /[\p{L}\p{N}]/u;
// What the last conversion replaced, so Backspace can restore it.
let markdownUndo = null;
// The caret just after a conversion: the next character typed there is
// plain, not a continuation of the styled text before it.
let markdownCaret = null;

function applyMarkdown() {
  const at = selectionOffsets();
  if (!at || at.start !== at.end) {
    return false;
  }
  const chars = readCompose();
  const close = at.start - 1;
  const mark = chars[close];
  const style = mark && !mark.mention && MARKDOWN_STYLE[mark.ch];
  if (!style) {
    return false;
  }
  let open = close - 1;
  while (open >= 0 && chars[open].ch !== '\n' && chars[open].ch !== mark.ch) {
    open -= 1;
  }
  if (open < 0 || chars[open].ch !== mark.ch || chars[open].mention) {
    return false;
  }
  const inner = chars.slice(open + 1, close);
  const before = chars[open - 1];
  if (
    inner.length === 0 ||
    /\s/.test(inner[0].ch) ||
    /\s/.test(inner.at(-1).ch) ||
    (before && !before.mention && WORD_CHAR.test(before.ch))
  ) {
    return false;
  }
  const styled = inner.map(c => ({
    ...c,
    styles: new Set([...c.styles, style]),
  }));
  const next = [...chars.slice(0, open), ...styled, ...chars.slice(close + 1)];
  drawCompose(next);
  const caret = close - 1;
  selectOffsets(caret);
  markdownUndo = { chars, caret, restore: at.start };
  markdownCaret = caret;
  return true;
}

function undoMarkdown() {
  const at = selectionOffsets();
  if (!markdownUndo || !at || at.start !== at.end) {
    return false;
  }
  if (at.start !== markdownUndo.caret) {
    markdownUndo = null;
    return false;
  }
  const { chars, restore } = markdownUndo;
  markdownUndo = null;
  markdownCaret = null;
  drawCompose(chars);
  selectOffsets(restore);
  return true;
}

// Unicode's mathematical letters: styled text that survives being pasted
// anywhere, an SMS included. Copies use the sans-serif set, which reads like
// the text around it; pastes also understand the serif set.
const UNICODE_SETS = [
  { styles: ['bold'], upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  { styles: ['italic'], upper: 0x1d608, lower: 0x1d622 },
  { styles: ['bold', 'italic'], upper: 0x1d63c, lower: 0x1d656 },
  { styles: ['monospace'], upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
  { styles: [], upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
  { styles: ['bold'], upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  { styles: ['italic'], upper: 0x1d434, lower: 0x1d44e },
  { styles: ['bold', 'italic'], upper: 0x1d468, lower: 0x1d482 },
];
const STRIKE_MARK = '̶';
// code point -> { ch, styles }
const FROM_UNICODE = new Map([[0x210e, { ch: 'h', styles: ['italic'] }]]);
// The first set listed wins where two share a letter.
const learn = (code, ch, styles) => {
  if (!FROM_UNICODE.has(code)) {
    FROM_UNICODE.set(code, { ch, styles });
  }
};
for (const set of UNICODE_SETS) {
  for (let i = 0; i < 26; i += 1) {
    learn(set.upper + i, String.fromCharCode(65 + i), set.styles);
    learn(set.lower + i, String.fromCharCode(97 + i), set.styles);
  }
  for (let i = 0; set.digit && i < 10; i += 1) {
    learn(set.digit + i, String(i), set.styles);
  }
}

function unicodeSet(styles) {
  if (styles.has('monospace')) {
    return UNICODE_SETS[3];
  }
  if (styles.has('bold') && styles.has('italic')) {
    return UNICODE_SETS[2];
  }
  if (styles.has('bold')) {
    return UNICODE_SETS[0];
  }
  if (styles.has('italic')) {
    return UNICODE_SETS[1];
  }
  return null;
}

// [{ text, styles: Set }] -> plain text with the styles written in.
function toUnicode(pieces) {
  let out = '';
  for (const { text, styles } of pieces) {
    const set = unicodeSet(styles);
    for (const ch of text) {
      let mapped = ch;
      if (set && /[A-Z]/.test(ch)) {
        mapped = String.fromCodePoint(set.upper + ch.charCodeAt(0) - 65);
      } else if (set && /[a-z]/.test(ch)) {
        mapped = String.fromCodePoint(set.lower + ch.charCodeAt(0) - 97);
      } else if (set && /[0-9]/.test(ch)) {
        // Bold italic uses bold digits; italic has none.
        const digit =
          set.digit ?? (styles.has('bold') ? UNICODE_SETS[0].digit : null);
        mapped = digit ? String.fromCodePoint(digit + Number(ch)) : ch;
      }
      out += mapped;
      if (styles.has('strikethrough') && ch !== '\n') {
        out += STRIKE_MARK;
      }
    }
  }
  return out;
}

// Pasted text: mathematical letters and struck characters become Signal's
// styles again.
function charsFromUnicode(text) {
  const chars = [];
  for (const c of charsOf(text)) {
    if (c.ch === STRIKE_MARK && chars.length > 0) {
      const last = chars.at(-1);
      last.styles = new Set([...last.styles, 'strikethrough']);
      continue;
    }
    const known = FROM_UNICODE.get(c.ch.codePointAt(0));
    chars.push(
      known
        ? { ch: known.ch, styles: new Set(known.styles) }
        : { ...c, styles: new Set() }
    );
  }
  return chars;
}

// A message as styled pieces, with mentions written out.
function messagePieces(m) {
  const text = m.body ?? '';
  const mentions = m.mentions ?? [];
  const formatting = m.formatting ?? [];
  const edges = new Set([0, text.length]);
  for (const r of [...mentions, ...formatting]) {
    edges.add(Math.max(0, Math.min(text.length, r.start)));
    edges.add(Math.max(0, Math.min(text.length, r.start + r.length)));
  }
  const points = [...edges].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const styles = new Set(
      formatting
        .filter(r => r.start <= start && r.start + r.length >= end)
        .map(r => r.style)
    );
    const mention = mentions.find(
      r => r.start <= start && r.start + r.length >= end
    );
    if (mention) {
      if (start === mention.start) {
        pieces.push({ text: `@${mention.title ?? 'Someone'}`, styles });
      }
    } else {
      pieces.push({ text: text.slice(start, end), styles });
    }
  }
  return pieces;
}

function hasUnicodeStyle(pieces) {
  return pieces.some(
    p => p.text && (unicodeSet(p.styles) || p.styles.has('strikethrough'))
  );
}

// Selected text in one message: its pieces, styles read from the page.
function selectedMessagePieces(range) {
  const bodyOf = node =>
    (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(
      '.body'
    );
  const body = bodyOf(range.startContainer);
  if (!body || body !== bodyOf(range.endContainer)) {
    return null;
  }
  const pieces = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) {
      continue;
    }
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    const styles = new Set();
    for (let p = node.parentElement; p && p !== body; p = p.parentElement) {
      for (const cls of p.classList) {
        if (CLASS_STYLE[cls] && CLASS_STYLE[cls] !== 'highlight') {
          styles.add(CLASS_STYLE[cls]);
        }
      }
    }
    pieces.push({ text: node.data.slice(from, to), styles });
  }
  return pieces;
}

// Selected text in the message box, as pieces.
function selectedComposePieces() {
  const at = selectionOffsets();
  if (!at || at.start === at.end) {
    return null;
  }
  return readCompose()
    .slice(at.start, at.end)
    .map(c => ({
      text: c.mention ? `@${c.mention.title ?? 'Someone'}` : c.ch,
      styles: c.styles,
    }));
}

function copyStyled(e, { cut = false } = {}) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return;
  }
  const inCompose = composeBox().contains(sel.anchorNode);
  const pieces = inCompose
    ? selectedComposePieces()
    : selectedMessagePieces(sel.getRangeAt(0));
  if (!pieces || !hasUnicodeStyle(pieces)) {
    return;
  }
  e.preventDefault();
  e.clipboardData.setData('text/plain', toUnicode(pieces));
  if (cut && inCompose) {
    const at = selectionOffsets();
    spliceCompose(at.start, at.end, []);
    composeBox().dispatchEvent(new Event('input'));
  }
}
document.addEventListener('copy', e => copyStyled(e));
document.addEventListener('cut', e => copyStyled(e, { cut: true }));

// --- message box events ----------------------------------------------------------
// The message box, and the forward dialog's (decision F32), share all of
// this; composeBox() is whichever one is being edited.
function wireComposeBox(box, onInput) {
  // Plain-text editing keeps the browser from adding its own markup; the
  // styles here come only from this code.
  box.contentEditable = 'plaintext-only';
  if (box.contentEditable !== 'plaintext-only') {
    box.contentEditable = 'true';
  }
  box.addEventListener('input', e => {
    if (
      e.inputType === 'insertText' &&
      MARKDOWN_STYLE[e.data] &&
      !e.isComposing &&
      applyMarkdown()
    ) {
      return;
    }
    markdownUndo = null;
    markdownCaret = null;
  });
  box.addEventListener('input', onInput);
  box.addEventListener('blur', () => {
    closeMentionPicker();
    $('format-bar').hidden = true;
  });
  box.addEventListener('beforeinput', e => {
    // The browser's own bold and the like would bypass Signal's styles.
    if (e.inputType.startsWith('format')) {
      e.preventDefault();
      return;
    }
    // Typing right after a markdown conversion starts plain text.
    const at = selectionOffsets();
    if (
      e.inputType === 'insertText' &&
      e.data &&
      !e.isComposing &&
      markdownCaret !== null &&
      at?.start === markdownCaret &&
      at.end === markdownCaret
    ) {
      e.preventDefault();
      markdownUndo = null;
      markdownCaret = null;
      spliceCompose(at.start, at.end, charsOf(e.data));
      if (!MARKDOWN_STYLE[e.data] || !applyMarkdown()) {
        markdownUndo = null;
        markdownCaret = null;
      }
      onInput();
    }
  });
  box.addEventListener('contextmenu', e => {
    const at = selectionOffsets();
    if (e.shiftKey || !at || at.start === at.end) {
      return;
    }
    e.preventDefault();
    openFormatMenu(e.clientX, e.clientY);
  });
  box.addEventListener('drop', e => {
    if (e.dataTransfer?.files.length) {
      return;
    }
    // Dropped text comes in plain, where it was dropped.
    e.preventDefault();
    const text = e.dataTransfer?.getData('text/plain') ?? '';
    const point = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (point && composeBox().contains(point.startContainer)) {
      const at = offsetAt(point.startContainer, point.startOffset);
      composeSelection = { start: at, end: at };
      window.getSelection().removeAllRanges();
    }
    insertPlain(text);
  });
  box.addEventListener(
    'keydown',
    e => {
      if (!$('mention-picker').hidden && mentionChoices.length > 0) {
        const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
        if (move) {
          mentionIndex =
            (mentionIndex + move + mentionChoices.length) %
            mentionChoices.length;
          renderMentionPicker();
        } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          pickMention(mentionChoices[mentionIndex]);
        } else if (e.key === 'Escape') {
          closeMentionPicker();
        } else {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertPlain('\n');
        return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && undoMarkdown()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onInput();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) {
        return;
      }
      const key = e.key.toLowerCase();
      const style = e.shiftKey
        ? { x: 'strikethrough', b: 'spoiler' }[key]
        : { b: 'bold', i: 'italic', e: 'monospace' }[key];
      if (style) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleStyle(style);
      } else if (key === 'u' && !e.shiftKey) {
        // Signal has no underline.
        e.preventDefault();
      }
    },
    { capture: true }
  );
}
wireComposeBox($('compose'), onComposeInput);
document.addEventListener('selectionchange', () => {
  const at = selectionOffsets();
  if (at) {
    composeSelection = at;
  }
  if (document.activeElement === composeBox()) {
    updateFormatBar();
    if (mentionQuery || !$('mention-picker').hidden) {
      updateMentionPicker();
    }
  }
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest?.('#format-menu')) {
    closeFormatMenu();
  }
});

// --- attachments to send ------------------------------------------------------

// conversationId -> [{ file, url }], kept per chat as Signal does.
const drafts = new Map();
const MAX_DRAFTS = 32;

function draftsFor(conversationId) {
  return drafts.get(conversationId) ?? [];
}

function addDrafts(fileList) {
  if (!selectedId) {
    return;
  }
  const list = [...draftsFor(selectedId)];
  for (const file of fileList) {
    if (list.length >= MAX_DRAFTS) {
      toast(`Up to ${MAX_DRAFTS} attachments at a time.`);
      break;
    }
    const url = file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : null;
    list.push({ file, url });
  }
  drafts.set(selectedId, list);
  renderDrafts();
  focusCompose();
}

function removeDraft(conversationId, draft) {
  if (draft.url) {
    URL.revokeObjectURL(draft.url);
  }
  drafts.set(
    conversationId,
    draftsFor(conversationId).filter(d => d !== draft)
  );
  renderDrafts();
}

function clearDrafts(conversationId) {
  for (const draft of draftsFor(conversationId)) {
    if (draft.url) {
      URL.revokeObjectURL(draft.url);
    }
  }
  drafts.delete(conversationId);
  renderDrafts();
}

function renderDrafts() {
  const tray = $('draft-tray');
  const list = selectedId ? draftsFor(selectedId) : [];
  tray.hidden = list.length === 0;
  const conversationId = selectedId;
  tray.replaceChildren(
    ...list.map(draft => {
      const tile = el('span', 'draft');
      if (draft.url) {
        const img = el('img', 'draft-image');
        img.alt = '';
        img.src = draft.url;
        tile.append(img);
      } else {
        tile.classList.add('draft-file');
        tile.append(
          icon('file'),
          el('span', 'draft-name', draft.file.name || 'File'),
          el('span', 'draft-size', formatSize(draft.file.size))
        );
      }
      const remove = el('button', 'draft-remove');
      remove.type = 'button';
      remove.title = 'Remove attachment';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.append(icon('close'));
      remove.addEventListener('click', () =>
        removeDraft(conversationId, draft)
      );
      tile.append(remove);
      return tile;
    })
  );
  scheduleLinkPreview();
}

async function uploadFile(file) {
  const params = new URLSearchParams({
    contentType: file.type || 'application/octet-stream',
    ...(file.name ? { name: file.name } : {}),
  });
  const res = await fetch(`api/upload?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 413) {
    // From a reverse proxy in front of the helper, not from Signal.
    const error = new Error('HTTP 413');
    error.reason = 'proxyTooLarge';
    throw error;
  }
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code;
    error.reason = data.error?.reason;
    throw error;
  }
  return data.uploadId;
}

// Files from the clipboard: screenshots, copied images, copied files.
// Text comes in plain; styles are set here, as in Signal.
$('compose').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])];
  e.preventDefault();
  if (files.length > 0) {
    if (!editing) {
      addDrafts(files);
    }
    return;
  }
  insertPlain(e.clipboardData?.getData('text/plain') ?? '');
});
$('settings-open').append(icon('settings'));
$('settings-open').addEventListener('click', openSettings);
$('chat-menu-open').append(icon('more'));
$('details-close').append(icon('close'));
$('details-close').addEventListener('click', closeDetails);
$('details').addEventListener('click', e => {
  if (e.target === $('details')) {
    closeDetails();
  }
});
// As Signal: the chat header opens the chat's details.
for (const id of ['chat-avatar', 'chat-title']) {
  $(id).addEventListener('click', () => {
    if (selectedId) {
      openDetails(selectedId);
    }
  });
}
$('chat-menu-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (selectedId) {
    openChatMenu(selectedId, $('chat-menu-open'));
  }
});
$('settings-close').append(icon('close'));
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', e => {
  if (e.target === $('settings')) {
    closeSettings();
  }
});
applyTheme(pageTheme());
$('sticker-open').append(icon('sticker'));
$('sticker-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (!$('sticker-picker').hidden) {
    closePopovers();
    return;
  }
  openStickerPicker($('sticker-open'));
});
$('emoji-open').append(icon('react'));
$('emoji-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (!$('emoji-picker').hidden) {
    closePopovers();
    return;
  }
  openEmojiPicker($('emoji-open'), insertEmoji);
});
$('attach').append(icon('attach'));
$('attach').addEventListener('click', () => $('attach-input').click());
$('attach-input').addEventListener('change', () => {
  addDrafts([...$('attach-input').files]);
  $('attach-input').value = '';
});
$('chat').addEventListener('dragover', e => {
  if (selectedId && e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    $('chat').classList.add('dropping');
  }
});
$('chat').addEventListener('dragleave', e => {
  if (e.target === $('chat') || !$('chat').contains(e.relatedTarget)) {
    $('chat').classList.remove('dropping');
  }
});
$('chat').addEventListener('drop', e => {
  $('chat').classList.remove('dropping');
  if (selectedId && e.dataTransfer?.files.length) {
    e.preventDefault();
    addDrafts([...e.dataTransfer.files]);
  }
});

// --- forward -----------------------------------------------------------------

// Unlike Signal: any number of chats, and every chat, most recent first.
let forwarding = null;
const forwardSelected = new Set();

function canForward(m) {
  return (
    (m.kind === 'text' || m.kind === 'sticker') &&
    (Boolean(m.body) || m.attachments.length > 0 || Boolean(m.sticker))
  );
}

function forwardCandidates() {
  const query = $('forward-search').value.trim().toLowerCase();
  return [...conversations.values()]
    .filter(c => !c.blocked)
    .filter(
      c =>
        !query ||
        displayTitle(c).toLowerCase().includes(query) ||
        c.title.toLowerCase().includes(query)
    )
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

function renderForwardList() {
  $('forward-list').replaceChildren(
    ...forwardCandidates().map(c => {
      const li = el('li');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = forwardSelected.has(c.id);
      li.append(
        box,
        conversationAvatar(c, 36),
        el('span', 'title', displayTitle(c))
      );
      li.classList.toggle('checked', box.checked);
      li.addEventListener('click', e => {
        if (e.target !== box) {
          box.checked = !box.checked;
        }
        if (box.checked) {
          forwardSelected.add(c.id);
        } else {
          forwardSelected.delete(c.id);
        }
        li.classList.toggle('checked', box.checked);
        renderForwardCount();
      });
      return li;
    })
  );
  renderForwardCount();
}

function renderForwardCount() {
  const n = forwardSelected.size;
  $('forward-count').textContent =
    n === 0 ? 'Pick chats' : `${n} chat${n === 1 ? '' : 's'} selected`;
  $('forward-send').disabled = n === 0 || forwardIsEmpty();
  const verb = forwarding?.kind === 'poll' ? 'Send' : 'Forward';
  $('forward-send').textContent = n > 1 ? `${verb} to ${n} chats` : verb;
}

function openForward(m) {
  forwarding = { kind: 'message', message: m };
  showForward([]);
  startForwardEdit(m);
}

// --- forward: edit the text, @mention, drop attachments (decision F32) ---------

// { original, keep: Set of attachment indexes, total, savedSelection }
let forwardEdit = null;

function startForwardEdit(m) {
  // Stickers go as they are, as in Signal.
  if (m.kind !== 'text') {
    return;
  }
  forwardEdit = {
    message: m,
    keep: new Set(m.attachments.map((_, i) => i)),
    savedSelection: composeSelection,
  };
  composeTarget = $('forward-compose');
  setCompose(m.body ?? '', m.mentions ?? [], m.formatting ?? []);
  forwardEdit.original = JSON.stringify(composeForSend());
  renderForwardAttachments();
  renderForwardEditNote();
  $('forward-edit').hidden = false;
}

function endForwardEdit() {
  if (!forwardEdit) {
    return;
  }
  closeMentionPicker();
  closeFormatMenu();
  $('format-bar').hidden = true;
  $('forward-compose').replaceChildren();
  composeTarget = null;
  composeSelection = forwardEdit.savedSelection;
  forwardEdit = null;
  $('forward-edit').hidden = true;
}

function renderForwardAttachments() {
  const m = forwardEdit.message;
  const tray = $('forward-attachments');
  tray.hidden = m.attachments.length === 0;
  tray.replaceChildren(
    ...m.attachments.flatMap((a, index) => {
      if (!forwardEdit.keep.has(index)) {
        return [];
      }
      const tile = el('span', 'draft');
      if (a.hasThumbnail) {
        const img = el('img', 'draft-image');
        img.alt = '';
        img.src = `api/thumbnail?${attachmentParams(m, index, {
          width: String(previewWidth(64)),
        })}`;
        tile.append(img);
      } else {
        tile.classList.add('draft-file');
        tile.append(
          icon('file'),
          el(
            'span',
            'draft-name',
            a.fileName ?? (a.isVoiceMessage ? 'Voice message' : 'File')
          )
        );
      }
      const remove = el('button', 'draft-remove');
      remove.type = 'button';
      remove.title = "Don't forward this";
      remove.setAttribute('aria-label', "Don't forward this");
      remove.append(icon('close'));
      remove.addEventListener('click', () => {
        forwardEdit.keep.delete(index);
        renderForwardAttachments();
        renderForwardCount();
      });
      tile.append(remove);
      return [tile];
    })
  );
}

// Mentions notify only where that person is in the group.
function renderForwardEditNote() {
  const hasMention = readCompose().some(c => c.mention);
  $('forward-mention-note').hidden = !hasMention;
}

function onForwardInput() {
  const box = composeBox();
  if (box.childNodes.length > 0 && readCompose().length === 0) {
    box.replaceChildren();
  }
  updateMentionPicker();
  updateFormatBar();
  renderForwardEditNote();
  renderForwardCount();
}

// The edit to send, or null when the message goes as it is.
function forwardEditPayload() {
  if (!forwardEdit) {
    return null;
  }
  const text = composeForSend();
  const total = forwardEdit.message.attachments.length;
  if (
    JSON.stringify(text) === forwardEdit.original &&
    forwardEdit.keep.size === total
  ) {
    return null;
  }
  return {
    body: text.body,
    ...(text.mentions.length > 0 ? { mentions: text.mentions } : {}),
    ...(text.formatting.length > 0 ? { formatting: text.formatting } : {}),
    attachmentIndexes: [...forwardEdit.keep].sort((a, b) => a - b),
  };
}

function forwardIsEmpty() {
  return (
    forwardEdit !== null &&
    forwardEdit.keep.size === 0 &&
    composeForSend().body.trim() === ''
  );
}

// Signal can't forward a poll; this sends a new poll with the same question
// and options to each chat instead.
function openPollForward(poll, preselected) {
  forwarding = { kind: 'poll', poll };
  showForward(preselected);
}

function showForward(preselected) {
  const poll = forwarding.kind === 'poll';
  $('forward-title').textContent = poll ? 'Send poll' : 'Forward message';
  $('forward-note').hidden = !poll;
  $('forward-note').textContent = poll
    ? 'Each chat gets its own copy of this poll, with its own votes.'
    : '';
  forwardSelected.clear();
  for (const id of preselected) {
    forwardSelected.add(id);
  }
  $('forward-search').value = '';
  renderForwardList();
  $('forward').hidden = false;
  $('forward-search').focus();
}

function closeForward() {
  endForwardEdit();
  forwarding = null;
  $('forward').hidden = true;
}

async function sendForward() {
  if (!forwarding || forwardSelected.size === 0) {
    return;
  }
  const conversationIds = [...forwardSelected];
  const poll = forwarding.kind === 'poll';
  const done = poll ? 'Sent' : 'Forwarded';
  const edit = poll ? null : forwardEditPayload();
  $('forward-send').disabled = true;
  try {
    const { results } = poll
      ? await api('api/pollSend', { conversationIds, ...forwarding.poll })
      : await api('api/forward', {
          messageId: forwarding.message.id,
          conversationIds,
          ...(edit ? { edit } : {}),
        });
    const failed = results.filter(r => !r.ok);
    closeForward();
    if (poll && failed.length < results.length) {
      closePollCompose();
    }
    if (failed.length === 0) {
      toast(
        `${done} to ${results.length} chat${results.length === 1 ? '' : 's'}.`
      );
    } else {
      const names = failed
        .map(r => {
          const c = conversations.get(r.conversationId);
          const why = SEND_ERRORS[r.reason] ?? r.reason ?? 'refused';
          return `${c ? displayTitle(c) : 'A chat'}: ${why}`;
        })
        .join('\n');
      window.alert(
        `${done} to ${results.length - failed.length} of ${results.length} chats. Not sent:\n${names}`
      );
    }
  } catch (error) {
    $('forward-send').disabled = false;
    toast(
      SEND_ERRORS[error.reason] ??
        `Not ${poll ? 'sent' : 'forwarded'} (${error.code ?? error.message}).`
    );
  }
}

$('forward-close').append(icon('close'));
$('forward-close').addEventListener('click', closeForward);
$('forward').addEventListener('click', e => {
  if (e.target === $('forward')) {
    closeForward();
  }
});
$('forward-search').addEventListener('input', renderForwardList);
wireComposeBox($('forward-compose'), onForwardInput);
$('forward-compose').addEventListener('paste', e => {
  e.preventDefault();
  insertPlain(e.clipboardData?.getData('text/plain') ?? '');
});
$('forward-compose').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    insertPlain('\n');
  }
});
$('forward-send').addEventListener('click', sendForward);

// --- polls ---------------------------------------------------------------------

const POLL_MAX_OPTIONS = 10;
const POLL_MAX_LENGTH = 100;

function canSend() {
  return capabilities.includes('messages.send');
}

// As Signal's poll bubble: question, how to vote, then each option with its
// count and a bar against the number of people who voted.
function renderPoll(m) {
  const { poll } = m;
  const box = el('div', `poll${poll.pending ? ' pending' : ''}`);
  box.append(el('div', 'poll-question', poll.question));
  box.append(
    el(
      'div',
      'poll-status',
      poll.ended
        ? 'Final results'
        : poll.allowMultiple
          ? 'Select multiple'
          : 'Select one'
    )
  );
  const voting = !poll.ended && canSend();
  const voted = poll.uniqueVoters > 0;
  poll.options.forEach((option, index) => {
    const row = el(voting ? 'label' : 'div', 'poll-option');
    if (voting) {
      const check = el('input');
      check.type = 'checkbox';
      check.checked = option.mine;
      check.addEventListener('change', () => votePoll(m, index, check.checked));
      row.append(check);
    }
    const main = el('span', 'poll-main');
    const top = el('span', 'poll-top');
    top.append(el('span', 'poll-text', option.text));
    if (voted) {
      const count = el('span', 'poll-count', String(option.voters.length));
      if (poll.ended && option.mine) {
        count.prepend(el('span', 'poll-mine', '✓ '));
      }
      top.append(count);
    }
    const bar = el('span', 'poll-bar');
    const fill = el('span', 'poll-fill');
    fill.style.width = `${voted ? (option.voters.length / poll.uniqueVoters) * 100 : 0}%`;
    bar.append(fill);
    main.append(top, bar);
    row.append(main);
    box.append(row);
  });
  if (voted) {
    const view = el('button', 'poll-view', 'View votes');
    view.type = 'button';
    view.addEventListener('click', () => openPollVotes(m));
    box.append(view);
  } else {
    box.append(el('div', 'poll-none', 'No votes'));
  }
  return box;
}

async function votePoll(m, index, checked) {
  const picked = new Set(
    m.poll.options.flatMap((option, i) => (option.mine ? [i] : []))
  );
  if (checked) {
    if (!m.poll.allowMultiple) {
      picked.clear();
    }
    picked.add(index);
  } else {
    picked.delete(index);
  }
  const optionIndexes = [...picked].sort((a, b) => a - b);
  // Show the vote at once; Signal's update replaces this.
  putMessage({
    ...m,
    poll: {
      ...m.poll,
      pending: true,
      options: m.poll.options.map((option, i) => ({
        ...option,
        mine: picked.has(i),
      })),
    },
  });
  renderMessages();
  try {
    await api('api/pollVote', { messageId: m.id, optionIndexes });
  } catch (error) {
    if (messages.has(m.id)) {
      putMessage(m);
      renderMessages();
    }
    toast(
      SEND_ERRORS[error.reason] ??
        `Vote not sent (${error.code ?? error.message}).`
    );
  }
}

async function endPoll(m) {
  if (!window.confirm('End this poll? No one will be able to vote.')) {
    return;
  }
  try {
    await api('api/pollEnd', { messageId: m.id });
    closePollVotes();
  } catch (error) {
    toast(
      SEND_ERRORS[error.reason] ??
        `Poll not ended (${error.code ?? error.message}).`
    );
  }
}

function voterName(conversationId) {
  return conversations.get(conversationId)?.noteToSelf
    ? 'You'
    : nameOf(conversationId);
}

let pollVotesFor = null;

function openPollVotes(m) {
  pollVotesFor = m.id;
  const { poll } = m;
  const body = $('poll-votes-body');
  body.replaceChildren(el('div', 'poll-votes-question', poll.question));
  poll.options.forEach(option => {
    if (option.voters.length === 0) {
      return;
    }
    const section = el('section', 'poll-votes-option');
    const head = el('div', 'poll-votes-head');
    head.append(
      el('span', '', option.text),
      el(
        'span',
        'sub',
        `${option.voters.length} vote${option.voters.length === 1 ? '' : 's'}`
      )
    );
    section.append(head);
    for (const id of option.voters) {
      const row = el('div', 'poll-voter');
      const who = authorOf(id) ?? { title: voterName(id) };
      row.append(avatar(id, who, 28), el('span', '', voterName(id)));
      section.append(row);
    }
    body.append(section);
  });
  $('poll-votes-foot').hidden = !(poll.canEnd && canSend());
  $('poll-votes').hidden = false;
}

function closePollVotes() {
  pollVotesFor = null;
  $('poll-votes').hidden = true;
}

function pollOptionInput(value = '') {
  const input = el('input');
  input.autocomplete = 'off';
  input.placeholder = 'Option';
  input.value = value;
  input.addEventListener('input', syncPollOptions);
  return input;
}

// Like Signal's dialog: there is always one empty option to type into, up to
// ten; emptied options in the middle go away.
function syncPollOptions() {
  const box = $('poll-option-inputs');
  const inputs = [...box.children];
  inputs.forEach((input, i) => {
    if (
      input.value === '' &&
      i < inputs.length - 1 &&
      inputs.length > 2 &&
      document.activeElement !== input
    ) {
      input.remove();
    }
  });
  const left = [...box.children];
  const last = left[left.length - 1];
  if (last.value !== '' && left.length < POLL_MAX_OPTIONS) {
    box.append(pollOptionInput());
  }
  while (box.children.length < 2) {
    box.append(pollOptionInput());
  }
  $('poll-send').disabled = !readPollForm();
}

function graphemes(text) {
  return [...segmenter.segment(text)].length;
}

// The poll as typed, or null if Signal would not send it yet.
function readPollForm() {
  const question = $('poll-question').value.trim();
  const options = [...$('poll-option-inputs').children]
    .map(input => input.value.trim())
    .filter(Boolean);
  if (
    !question ||
    graphemes(question) > POLL_MAX_LENGTH ||
    options.length < 2 ||
    options.some(option => graphemes(option) > POLL_MAX_LENGTH)
  ) {
    return null;
  }
  return { question, options, allowMultiple: $('poll-multiple').checked };
}

function openPollCompose() {
  $('poll-question').value = '';
  $('poll-multiple').checked = false;
  $('poll-option-inputs').replaceChildren(pollOptionInput(), pollOptionInput());
  $('poll-send').disabled = true;
  $('poll-compose').hidden = false;
  $('poll-question').focus();
}

function closePollCompose() {
  $('poll-compose').hidden = true;
}

async function sendPollHere() {
  const poll = readPollForm();
  if (!poll || !selectedId) {
    return;
  }
  $('poll-send').disabled = true;
  try {
    const { results } = await api('api/pollSend', {
      conversationIds: [selectedId],
      ...poll,
    });
    const [result] = results;
    if (result?.ok) {
      closePollCompose();
    } else {
      $('poll-send').disabled = false;
      toast(SEND_ERRORS[result?.reason] ?? 'Poll not sent.');
    }
  } catch (error) {
    $('poll-send').disabled = false;
    toast(
      SEND_ERRORS[error.reason] ??
        `Poll not sent (${error.code ?? error.message}).`
    );
  }
}

$('record').append(icon('mic'));
$('record').addEventListener('click', startRecording);
$('record-cancel').append(icon('trash'));
$('record-cancel').addEventListener('click', cancelRecording);
$('record-send').addEventListener('click', () =>
  recording ? stopRecording({ send: true }) : sendVoiceDraft()
);
// As Signal: leaving the window keeps the recording as a draft.
window.addEventListener('blur', () => {
  if (recording) {
    stopRecording({ send: false });
  }
});
$('compose-open').append(icon('edit'));
$('compose-open').addEventListener('click', openNewChat);
$('new-chat-close').append(icon('close'));
$('new-chat-close').addEventListener('click', closeNewChat);
$('new-chat-back').append(icon('back'));
$('new-chat-back').addEventListener('click', () =>
  showComposeStep(composeStep === 'info' ? 'members' : 'chat')
);
$('new-chat-search').addEventListener('input', renderComposeList);
$('new-chat-search').addEventListener('keydown', e => {
  const query = $('new-chat-search').value.trim();
  if (e.key === 'Enter' && composeStep === 'chat' && looksFindable(query)) {
    findAndOpen(query);
  }
});
$('new-chat-next').addEventListener('click', composeNext);
$('new-group-name').addEventListener('input', updateGroupNext);
$('new-group-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    composeNext();
  }
});
$('new-group-photo').addEventListener('click', () =>
  $('new-group-photo-input').click()
);
$('new-group-photo-input').addEventListener('change', () => {
  const [file] = $('new-group-photo-input').files;
  $('new-group-photo-input').value = '';
  if (!file) {
    return;
  }
  if (file.size > 600 * 1024) {
    toast('That photo is too large (600 KB at most).');
    return;
  }
  clearGroupPhoto();
  groupPhoto = file;
  groupPhotoUrl = URL.createObjectURL(file);
  renderGroupPhoto();
});
$('new-chat').addEventListener('click', e => {
  if (e.target === $('new-chat')) {
    closeNewChat();
  }
});
$('poll-open').append(icon('poll'));
$('poll-open').addEventListener('click', openPollCompose);
$('poll-compose-close').append(icon('close'));
$('poll-compose-close').addEventListener('click', () => closePollCompose());
$('poll-question').addEventListener('input', syncPollOptions);
$('poll-multiple').addEventListener('change', syncPollOptions);
$('poll-option-inputs').addEventListener('focusout', () =>
  setTimeout(syncPollOptions)
);
$('poll-compose').addEventListener('submit', e => {
  e.preventDefault();
  sendPollHere();
});
$('poll-choose').addEventListener('click', () => {
  const poll = readPollForm();
  if (!poll) {
    toast('Add a question and at least two options.');
    return;
  }
  openPollForward(poll, selectedId ? [selectedId] : []);
});
$('poll-votes-close').append(icon('close'));
$('poll-votes-close').addEventListener('click', closePollVotes);
$('poll-end').addEventListener('click', () => {
  const m = messages.get(pollVotesFor);
  if (m) {
    endPoll(m);
  }
});
for (const id of ['poll-compose', 'poll-votes']) {
  $(id).addEventListener('click', e => {
    if (e.target === $(id)) {
      $(id).hidden = true;
    }
  });
}

// --- narrow windows ------------------------------------------------------------

// Below the breakpoint the chat list shows photos only, as Signal's does;
// search opens it full width over the chat.
function collapseSidebar() {
  document.querySelector('.sidebar').classList.remove('expanded');
}

$('chat').addEventListener('pointerdown', collapseSidebar);
$('search-open').append(icon('search'));
$('search-open').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.add('expanded');
  $('search').focus();
});

$('composer').addEventListener('submit', e => {
  e.preventDefault();
  if (sendHeld) {
    sendHeld = false;
    return;
  }
  sendCurrent();
});
// Hold or right-click Send to schedule (decision F29).
let sendHeld = false;
let sendHoldTimer = null;
$('send').addEventListener('contextmenu', e => {
  e.preventDefault();
  openSchedule();
});
$('send').addEventListener('pointerdown', e => {
  sendHeld = false;
  if (e.pointerType !== 'mouse') {
    sendHoldTimer = setTimeout(() => {
      sendHeld = true;
      openSchedule();
    }, 500);
  }
});
for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
  $('send').addEventListener(type, () => clearTimeout(sendHoldTimer));
}
$('schedule-close').append(icon('close'));
$('schedule-close').addEventListener('click', closeSchedule);
$('schedule').addEventListener('click', e => {
  if (e.target === $('schedule')) {
    closeSchedule();
  }
});
$('schedule-send').addEventListener('click', () => {
  const value = $('schedule-at').value;
  pickScheduleTime(value ? new Date(value).getTime() : NaN);
});
$('schedule-at').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('schedule-send').click();
  }
});
$('scheduled-open').prepend(icon('clock'));
$('scheduled-open').addEventListener('click', openScheduledList);
$('scheduled-close').append(icon('close'));
$('scheduled-close').addEventListener('click', closeScheduledList);
$('scheduled').addEventListener('click', e => {
  if (e.target === $('scheduled')) {
    closeScheduledList();
  }
});
$('compose').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendCurrent();
  } else if (e.key === 'Escape' && (replyTo || editing)) {
    cancelReply();
  }
});
$('older').addEventListener('click', () => loadMessages({ older: true }));
$('newer-load').addEventListener('click', loadNewer);
$('to-newest').prepend(icon('down'));
$('to-newest').addEventListener('click', goToNewest);
$('latest').addEventListener('click', showLatest);
$('search').addEventListener('input', () => {
  scheduleSearch();
  renderConversations();
});
$('search').addEventListener('keydown', e => {
  if (e.key === 'Escape' && searchScope && $('search').value === '') {
    endChatSearch();
  }
});
$('filter-unread').append(icon('filter'));
$('filter-unread').addEventListener('click', () =>
  setListFilter(listFilter, !unreadOnly)
);
$('banner-action').addEventListener('click', () =>
  api('api/retry', {}).catch(() => {})
);
$('reply-cancel').append(icon('close'));
$('compose-preview-close').append(icon('close'));
$('compose-preview-close').addEventListener('click', dismissLinkPreview);
$('lightbox-close').append(icon('close'));
$('lightbox-save').append(icon('download'));
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-goto').append(icon('goto'));
$('lightbox-goto').addEventListener('click', () => {
  const m = lightbox?.gallery;
  if (m) {
    closeLightbox();
    closeGallery();
    jumpToMessage(m);
  }
});
$('gallery-close').append(icon('close'));
$('gallery-close').addEventListener('click', closeGallery);
$('gallery').addEventListener('click', e => {
  if (e.target === $('gallery')) {
    closeGallery();
  }
});
$('gallery-tabs').replaceChildren(
  ...GALLERY_TABS.map(([kind, label]) => {
    const tab = el('button', 'gallery-tab', label);
    tab.type = 'button';
    tab.dataset.kind = kind;
    tab.addEventListener('click', () => {
      if (gallery && gallery.kind !== kind) {
        showGalleryTab(kind);
      }
    });
    return tab;
  })
);
$('gallery-body').addEventListener(
  'scroll',
  () => {
    const body = $('gallery-body');
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 300) {
      loadGalleryPage();
    }
  },
  { passive: true }
);
$('lightbox-prev').append(icon('back'));
$('lightbox-next').append(icon('next'));
$('lightbox-prev').addEventListener('click', () => stepLightbox(-1));
$('lightbox-next').addEventListener('click', () => stepLightbox(1));
document.addEventListener('keydown', e => {
  if (!lightbox || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    stepLightbox(e.key === 'ArrowLeft' ? -1 : 1);
  }
});
// A swipe on a touch screen.
let swipeFrom = null;
let swiped = false;
$('lightbox-stage').addEventListener('pointerdown', e => {
  swipeFrom = e.pointerType === 'mouse' ? null : e.clientX;
  swiped = false;
});
$('lightbox-stage').addEventListener('pointerup', e => {
  if (swipeFrom !== null && Math.abs(e.clientX - swipeFrom) > 50) {
    // Not also a tap that closes the viewer.
    swiped = true;
    stepLightbox(e.clientX < swipeFrom ? 1 : -1);
  }
  swipeFrom = null;
});
$('lightbox').addEventListener('click', e => {
  if (swiped) {
    swiped = false;
    return;
  }
  if (
    e.target === $('lightbox') ||
    e.target === $('lightbox-stage') ||
    e.target.classList.contains('lightbox-main')
  ) {
    closeLightbox();
  }
});
$('reply-cancel').addEventListener('click', cancelReply);
document.addEventListener('click', e => {
  if (!e.target.closest?.('.popover')) {
    closePopovers();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && recording) {
    cancelRecording();
    return;
  }
  if (e.key === 'Escape') {
    closePopovers();
    if (lightbox) {
      closeLightbox();
      return;
    }
    if (!$('gallery').hidden) {
      closeGallery();
    } else if (!$('schedule').hidden) {
      closeSchedule();
    } else if (!$('scheduled').hidden) {
      closeScheduledList();
    } else if (!$('forward').hidden) {
      closeForward();
    } else if (!$('new-chat').hidden) {
      closeNewChat();
    } else {
      closePollCompose();
      closePollVotes();
      closeSettings();
      closeDetails();
    }
    collapseSidebar();
  }
});
$('messages').addEventListener('scroll', closePopovers, { passive: true });
// As Signal: reaching the newest message marks the chat read.
$('messages').addEventListener(
  'scroll',
  () => {
    const box = $('messages');
    renderToNewest();
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
      if (newerCursor === null) {
        maybeMarkRead();
      } else {
        loadNewer();
      }
    }
  },
  { passive: true }
);
// Rambox may not move window focus on a click into the page.
document.addEventListener('pointerdown', () => setTimeout(maybeMarkRead, 0));
window.addEventListener('focus', maybeMarkRead);
document.addEventListener('visibilitychange', maybeMarkRead);
// Relative times in the list ("5m") move on.
setInterval(() => {
  if (conversations.size > 0) {
    renderConversations();
  }
}, 60_000);

// Signal's emoji fonts are CBDT bitmaps, which some browsers
// (Firefox and Safari on macOS) can't draw; they show empty boxes. Draw an
// emoji with Signal's font and, if nothing in color comes out, switch the
// page to the system's emoji font (see .system-emoji in app.css).
async function checkEmojiFont() {
  try {
    await document.fonts.load('32px "Signal Emoji Small"', '😀');
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = '32px "Signal Emoji Small"';
    ctx.textBaseline = 'top';
    ctx.fillText('😀', 4, 4);
    const { data } = ctx.getImageData(0, 0, 48, 48);
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 40) {
        return;
      }
    }
  } catch {
    // Can't tell; the system font is the safe choice.
  }
  document.documentElement.classList.add('system-emoji');
}

checkEmojiFont();
renderBanner();
connectEvents();
