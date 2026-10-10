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
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
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

function sortedConversations() {
  const query = $('search').value.trim().toLowerCase();
  return [...conversations.values()]
    .filter(c => (query ? c.title.toLowerCase().includes(query) : !c.archived))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
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
  ]);
  const cached = rowCache.get(c.id);
  if (cached && cached.key === key) {
    return cached.li;
  }
  const li = el('li');
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(c.id === selectedId));
  li.className = [unread ? 'unread' : '', c.muted ? 'muted' : ''].join(' ');
  const text = el('span', 'row-text');
  const top = el('span', 'row-top');
  top.append(
    el('span', 'title', displayTitle(c)),
    el('span', 'time', shortTime(c.lastActivityAt))
  );
  text.append(top);
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

function renderConversations() {
  $('conversations').replaceChildren(
    ...sortedConversations().map(conversationRow)
  );
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
    if (mine && canReact()) {
      chip.addEventListener('click', () => sendReaction(m, emoji, true));
    }
    box.append(chip);
  }
  return box;
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
    img.src = `api/thumbnail?${attachmentParams(m, index)}`;
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
  if (m.kind === 'sticker') {
    bubble.classList.add('sticker-bubble');
    bubble.append(renderSticker(m));
  } else if (m.kind !== 'text') {
    bubble.append(el('span', 'body note', summarize(m)));
  } else if (m.body) {
    bubble.append(
      el(
        'span',
        'body',
        m.bodyTruncated ? `${m.body}… (open Signal for more)` : m.body
      )
    );
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
}

function placePopover(popover, anchor) {
  popover.hidden = false;
  const a = anchor.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, a.left + a.width / 2 - p.width / 2),
    window.innerWidth - p.width - 8
  );
  const above = a.top - p.height - 6;
  const top = above >= 8 ? above : a.bottom + 6;
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
    })
  );
  placePopover(picker, anchor);
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
    add('copy', 'Copy text', () => copyText(m.body));
  }
  if (canReplyTo(m)) {
    add('reply', 'Reply', () => startReply(m));
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
  replyTo = null;
  $('reply-bar').hidden = true;
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
  if (!selectedId || body.trim() === '') {
    return;
  }
  $('send').disabled = true;
  $('send-error').hidden = true;
  try {
    const { message } = await api('api/send', {
      conversationId: selectedId,
      body,
      ...(replyTo ? { quoteMessageId: replyTo.id } : {}),
    });
    box.value = '';
    autosize();
    cancelReply();
    putMessage(message);
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`
    );
  } finally {
    $('send').disabled = false;
    box.focus();
  }
}

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
  } else if (e.key === 'Escape' && replyTo) {
    cancelReply();
  }
});
$('compose').addEventListener('input', autosize);
$('older').addEventListener('click', () => loadMessages({ older: true }));
$('search').addEventListener('input', renderConversations);
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
