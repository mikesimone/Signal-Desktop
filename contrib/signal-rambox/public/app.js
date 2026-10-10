// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The chat page Rambox shows. Talks only to the signal-rambox helper that
// served it (same origin; the token is part of the page's own path).
// All text from Signal goes into the page through textContent, never HTML.

'use strict';

const $ = id => document.getElementById(id);

const conversations = new Map();
// conversationId -> AuthorDTO, from messages (group members usually have no
// listed conversation of their own).
const authors = new Map();
let capabilities = [];
let selectedId = null;
let messages = new Map();
let nextCursor = null;
let bridgeState = 'offline';
let helperConnected = false;
let markReadInFlight = false;
let replyTo = null;
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
  awaitingApproval: 'Approve "Rambox (signal-rambox)" in the Signal window.',
  denied: 'Signal did not allow this app.',
  keyMismatch:
    "Signal's identity key changed since this app was approved. Delete " +
    'key.json in the signal-rambox config folder and restart it to pair again.',
  loading: 'Loading chats…',
};

const SEND_ERRORS = {
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
    text = "The signal-rambox helper isn't running. Start it, then reload.";
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
  document.title = total > 0 ? `(${total}) Signal` : 'Signal';
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
        : !c.archived
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
  text.append(top, el('span', 'preview', previewLine(c)));
  li.append(conversationAvatar(c, 48), text);
  if (unread) {
    li.append(
      el('span', 'badge', c.unreadCount > 0 ? String(c.unreadCount) : '')
    );
  }
  li.addEventListener('click', () => selectConversation(c.id));
  rowCache.set(c.id, { key, li });
  return li;
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
  const list = sortedConversations();
  const searching = $('search').value.trim() !== '';
  const pinned = list.filter(c => c.pinned);
  const others = list.filter(c => !c.pinned);
  const rows =
    searching || pinned.length === 0
      ? list.map(conversationRow)
      : [
          sectionHead('Pinned'),
          ...pinned.map(conversationRow),
          ...(others.length > 0 ? [sectionHead('Chats')] : []),
          ...others.map(conversationRow),
        ];
  if (rows.length === 0 && bridgeState === 'ready') {
    rows.push(
      el('li', 'list-empty', unreadOnly ? 'No unread chats' : 'No chats')
    );
  }
  $('conversations').replaceChildren(...rows);
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

function renderQuote(quote) {
  const box = el('span', 'quote');
  const author = quote.author ?? authorOf(quote.authorConversationId);
  if (author?.nameColor) {
    box.classList.add(`nc-${author.nameColor}`);
  }
  box.append(
    nameLine(nameOf(quote.authorConversationId), author, 'quote-author'),
    el('span', 'quote-text', quote.text ?? 'Attachment')
  );
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
          row.append(avatar(id, who, 32), name, el('span', 'emoji', r.emoji));
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

// Full-size view of a message's photos and videos, like Signal's.
function openLightbox(m, index) {
  const a = m.attachments[index];
  const box = $('lightbox');
  const stage = $('lightbox-stage');
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
  stage.replaceChildren(content);
  $('lightbox-caption').textContent = a.caption ?? '';
  $('lightbox-save').href = attachmentUrl(m, index, a, { download: '1' });
  $('lightbox-save').download = a.fileName ?? 'attachment';
  box.hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-stage').replaceChildren();
}

// --- message text: mentions, formatting, links ----------------------------------

// The body with mentions written out, for copying and quoting.
function plainText(m) {
  let text = m.body ?? '';
  for (const mention of [...(m.mentions ?? [])].sort(
    (a, b) => b.start - a.start
  )) {
    text =
      text.slice(0, mention.start) +
      `@${mention.title ?? 'Someone'}` +
      text.slice(mention.start + mention.length);
  }
  return text;
}

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
      li.append(avatar(m.authorConversationId, who, 28));
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
    bubble.append(nameLine(nameOf(m.authorConversationId), m.author, 'author'));
  }
  if (m.quote) {
    bubble.append(renderQuote(m.quote));
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
  if (m.sendStatus) {
    bits.push(STATUS_TEXT[m.sendStatus] ?? m.sendStatus);
  }
  meta.textContent = bits.join(' · ');
  bubble.append(meta);

  const line = el('span', 'bubble-line');
  line.append(bubble, renderActions(m));
  column.append(line);
  if (m.reactions.length > 0) {
    column.append(renderReactions(m));
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

function renderMessages({ keepBottom = true } = {}) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousHeight = box.scrollHeight;
  const list = sortedMessages();
  patchChildren(
    $('message-list'),
    list.map((m, i) => cachedMessage(m, list[i - 1], list[i + 1]))
  );
  for (const id of messageCache.keys()) {
    if (!messages.has(id)) {
      messageCache.delete(id);
    }
  }
  $('older').hidden = !nextCursor;
  if (keepBottom && atBottom) {
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

function renderChatHeader() {
  const c = conversations.get(selectedId);
  $('chat-title').textContent = c ? displayTitle(c) : '';
  $('chat-avatar').replaceChildren(...(c ? [conversationAvatar(c, 36)] : []));
  const sub = [];
  if (c?.type === 'group' && c.memberCount) {
    sub.push(`${c.memberCount} members`);
  }
  if (c?.muted) {
    sub.push('muted');
  }
  $('chat-sub').textContent = sub.join(' · ');
}

async function selectConversation(id) {
  if (id === selectedId) {
    return;
  }
  selectedId = id;
  messages = new Map();
  nextCursor = null;
  collapseSidebar();
  renderDrafts();
  clearExpiryTimers();
  closePopovers();
  cancelReply();
  $('send-error').hidden = true;
  $('empty').hidden = true;
  $('chat-head').hidden = false;
  $('messages').hidden = false;
  $('composer').hidden = false;
  renderChatHeader();
  renderConversations();
  $('message-list').replaceChildren();
  try {
    await loadMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(`Couldn't load messages (${error.code ?? error.message}).`);
  }
  $('compose').focus();
  maybeMarkRead();
}

// Marks the open chat read in Signal, only while the user can see it.
async function maybeMarkRead() {
  const c = conversations.get(selectedId);
  if (
    !c ||
    markReadInFlight ||
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
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2000);
}

// --- message actions ---------------------------------------------------------

function closePopovers() {
  $('reaction-picker').hidden = true;
  $('more-menu').hidden = true;
  $('emoji-picker').hidden = true;
  $('reaction-viewer').hidden = true;
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

  picker.replaceChildren(search, body, tabs);
  placePopover(picker, anchor);
  search.focus();
}

// The composer's emoji button inserts at the cursor.
function insertEmoji(e) {
  const box = $('compose');
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = box.value.slice(0, start) + e + box.value.slice(end);
  const at = start + e.length;
  box.focus();
  box.setSelectionRange(at, at);
  autosize();
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
    add('copy', 'Copy text', () => copyText(plainText(m)));
  }
  if (canReplyTo(m)) {
    add('reply', 'Reply', () => startReply(m));
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
    el('span', 'quote-text', summarize(m))
  );
  quote.className = 'reply-quote';
  if (m.direction !== 'outgoing' && m.author?.nameColor) {
    quote.classList.add(`nc-${m.author.nameColor}`);
  }
  $('reply-bar').hidden = false;
  $('compose').focus();
}

function cancelReply() {
  const wasEditing = editing !== null;
  replyTo = null;
  editing = null;
  $('reply-bar').hidden = true;
  $('reply-bar').classList.remove('editing');
  if (wasEditing) {
    $('compose').value = '';
    autosize();
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
  const box = $('compose');
  box.value = plainText(m);
  autosize();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
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
  const show = () => {
    const text = summarize(m);
    const body =
      c.type === 'group' ? `${nameOf(m.authorConversationId)}: ${text}` : text;
    const n = new Notification(displayTitle(c), {
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
      tag: m.conversationId,
      icon: c.avatarVersion
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
  preferredReactions = null;
  conversations.clear();
  rowCache.clear();
  for (const c of state.conversations) {
    conversations.set(c.id, c);
  }
  renderBanner();
  renderTitle();
  renderConversations();
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

function connectEvents() {
  const source = new EventSource('api/events');
  const on = (type, handler) =>
    source.addEventListener(type, e => handler(JSON.parse(e.data)));

  on('hello', () => {
    helperConnected = true;
    loadState().catch(() => {});
  });
  on('resync', () => loadState().catch(() => {}));
  on('state', ({ state }) => {
    bridgeState = state;
    if (state !== 'ready') {
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
  on('conversation.removed', ({ conversationId }) => {
    conversations.delete(conversationId);
    rowCache.delete(conversationId);
    renderConversations();
    renderTitle();
  });
  on('message.added', m => {
    rememberAuthors(m);
    if (m.conversationId === selectedId) {
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
    // EventSource reconnects by itself; say so meanwhile.
    helperConnected = false;
    renderBanner();
  });
}

// --- composer ------------------------------------------------------------------

async function sendCurrent() {
  const box = $('compose');
  const body = box.value;
  const conversationId = selectedId;
  const files = editing ? [] : draftsFor(conversationId);
  if (!conversationId || (body.trim() === '' && files.length === 0)) {
    return;
  }
  $('send').disabled = true;
  $('send-error').hidden = true;
  try {
    if (editing) {
      await api('api/edit', { messageId: editing.id, body });
      cancelReply();
      box.value = '';
      autosize();
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
      body: files.length > 0 ? body.trim() : body,
      ...(replyTo ? { quoteMessageId: replyTo.id } : {}),
      ...(attachmentUploadIds.length > 0 ? { attachmentUploadIds } : {}),
    });
    clearDrafts(conversationId);
    box.value = '';
    autosize();
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
    box.focus();
  }
}

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
  $('compose').focus();
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
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code;
    error.reason = data.error?.reason;
    throw error;
  }
  return data.uploadId;
}

// Files from the clipboard: screenshots, copied images, copied files.
$('compose').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length > 0 && !editing) {
    e.preventDefault();
    addDrafts(files);
  }
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
  $('forward-send').disabled = n === 0;
  const verb = forwarding?.kind === 'poll' ? 'Send' : 'Forward';
  $('forward-send').textContent = n > 1 ? `${verb} to ${n} chats` : verb;
}

function openForward(m) {
  forwarding = { kind: 'message', message: m };
  showForward([]);
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
  $('forward-send').disabled = true;
  try {
    const { results } = poll
      ? await api('api/pollSend', { conversationIds, ...forwarding.poll })
      : await api('api/forward', {
          messageId: forwarding.message.id,
          conversationIds,
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

function autosize() {
  const box = $('compose');
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

$('composer').addEventListener('submit', e => {
  e.preventDefault();
  sendCurrent();
});
$('compose').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendCurrent();
  } else if (e.key === 'Escape' && (replyTo || editing)) {
    cancelReply();
  }
});
$('compose').addEventListener('input', autosize);
$('older').addEventListener('click', () => loadMessages({ older: true }));
$('search').addEventListener('input', renderConversations);
$('filter-unread').append(icon('filter'));
$('filter-unread').addEventListener('click', () =>
  setListFilter(listFilter, !unreadOnly)
);
$('banner-action').addEventListener('click', () =>
  api('api/retry', {}).catch(() => {})
);
$('reply-cancel').append(icon('close'));
$('lightbox-close').append(icon('close'));
$('lightbox-save').append(icon('download'));
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', e => {
  if (e.target === $('lightbox') || e.target === $('lightbox-stage')) {
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
  if (e.key === 'Escape') {
    closePopovers();
    closeLightbox();
    if (!$('forward').hidden) {
      closeForward();
    } else {
      closePollCompose();
      closePollVotes();
    }
    collapseSidebar();
  }
});
$('messages').addEventListener('scroll', closePopovers, { passive: true });
window.addEventListener('focus', maybeMarkRead);
document.addEventListener('visibilitychange', maybeMarkRead);
// Relative times in the list ("5m") move on.
setInterval(() => {
  if (conversations.size > 0) {
    renderConversations();
  }
}, 60_000);

renderBanner();
connectEvents();
