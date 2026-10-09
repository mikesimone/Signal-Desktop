// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The chat page Rambox shows. Talks only to the signal-rambox helper that
// served it (same origin; the token is part of the page's own path).
// All text from Signal goes into the page through textContent, never HTML.

'use strict';

const $ = id => document.getElementById(id);

const conversations = new Map();
let selectedId = null;
let messages = new Map();
let nextCursor = null;
let bridgeState = 'offline';
let helperConnected = false;
let markReadInFlight = false;
const expiryTimers = new Map();

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

function renderConversations() {
  const list = $('conversations');
  const items = sortedConversations().map(c => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(c.id === selectedId));
    const unread = c.unreadCount > 0 || c.markedUnread;
    li.className = [unread ? 'unread' : '', c.muted ? 'muted' : ''].join(' ');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.noteToSelf ? 'Note to Self' : c.title;
    li.append(title);
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = c.unreadCount > 0 ? String(c.unreadCount) : '';
      li.append(badge);
    }
    li.addEventListener('click', () => selectConversation(c.id));
    return li;
  });
  list.replaceChildren(...items);
}

// --- messages --------------------------------------------------------------

function nameOf(conversationId) {
  const c = conversationId ? conversations.get(conversationId) : undefined;
  return c ? c.title : 'Someone';
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

function renderMessage(m) {
  const li = document.createElement('li');
  li.className = `msg ${m.direction === 'outgoing' ? 'out' : 'in'}`;
  const conversation = conversations.get(m.conversationId);
  if (m.direction === 'incoming' && conversation?.type === 'group') {
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = nameOf(m.authorConversationId);
    li.append(author);
  }
  if (m.quote) {
    const quote = document.createElement('span');
    quote.className = 'quote';
    quote.textContent = `${nameOf(m.quote.authorConversationId)}: ${
      m.quote.text ?? 'Attachment'
    }`;
    li.append(quote);
  }
  const body = document.createElement('span');
  if (m.kind === 'text') {
    const parts = [];
    if (m.body) {
      parts.push(
        m.bodyTruncated ? `${m.body}… (open Signal for more)` : m.body
      );
    }
    for (const a of describeAttachments(m.attachments)) {
      parts.push(`[${a}: open Signal to view]`);
    }
    body.textContent = parts.join('\n');
  } else {
    body.className = 'note';
    body.textContent = summarize(m);
  }
  li.append(body);
  if (m.reactions.length > 0) {
    const reactions = document.createElement('span');
    reactions.className = 'reactions';
    reactions.textContent = m.reactions.map(r => r.emoji).join(' ');
    li.append(reactions);
  }
  const meta = document.createElement('span');
  meta.className = 'meta';
  const bits = [formatTime(m.sentAt)];
  if (m.edited) {
    bits.push('edited');
  }
  if (m.sendStatus) {
    bits.push(STATUS_TEXT[m.sendStatus] ?? m.sendStatus);
  }
  meta.textContent = bits.join(' · ');
  li.append(meta);
  return li;
}

function sortedMessages() {
  return [...messages.values()].sort((a, b) => a.sentAt - b.sentAt);
}

function renderMessages({ keepBottom = true } = {}) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousHeight = box.scrollHeight;
  $('message-list').replaceChildren(...sortedMessages().map(renderMessage));
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
  $('chat-title').textContent = c
    ? c.noteToSelf
      ? 'Note to Self'
      : c.title
    : '';
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
    $('send-error').hidden = false;
    $('send-error').textContent =
      `Couldn't load messages (${error.code ?? error.message}).`;
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
    const n = new Notification(c.noteToSelf ? 'Note to Self' : c.title, {
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
      tag: m.conversationId,
      icon: 'icon.svg',
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
  conversations.clear();
  for (const c of state.conversations) {
    conversations.set(c.id, c);
  }
  renderBanner();
  renderTitle();
  renderConversations();
  if (selectedId && !conversations.has(selectedId)) {
    selectedId = null;
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
    renderConversations();
    renderTitle();
  });
  on('message.added', m => {
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
    });
    box.value = '';
    autosize();
    putMessage(message);
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    $('send-error').hidden = false;
    $('send-error').textContent =
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`;
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
  }
});
$('compose').addEventListener('input', autosize);
$('older').addEventListener('click', () => loadMessages({ older: true }));
$('search').addEventListener('input', renderConversations);
$('banner-action').addEventListener('click', () =>
  api('api/retry', {}).catch(() => {})
);
window.addEventListener('focus', maybeMarkRead);
document.addEventListener('visibilitychange', maybeMarkRead);

renderBanner();
connectEvents();
