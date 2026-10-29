<!-- Copyright 2026 Signal Messenger, LLC -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# External Client Bridge: Decision Log

Baseline: `5c1a030485ea64a1c311288cd6b5eecbe36964cd`.

## D1. Split the bridge between main and renderer

DECISION: Transport, session, authentication, authorization and limits run in
the Electron main process. A thin service adapter runs in the main window
renderer and calls existing Signal code.

WHY:

- All messaging logic (models, `ConversationController`, `MessageCache`,
  `textsecure`, job queues) runs in the renderer preload world.
- Main survives renderer reloads and owns windows, so it can own the approval
  UI and keep untrusted parsing out of the process that runs React.

ALTERNATIVES: listener in the renderer; answer reads from SQL in main.

TRADEOFF: one extra IPC hop per call; the renderer must be up for data
methods.

## D2. Local IPC only: named pipe on Windows, Unix socket elsewhere

DECISION: `net.createServer().listen(path)` on a per-user named pipe or a Unix
domain socket in a `0700` directory.

WHY: no network listener; OS user boundary; native to Node, so no dependency;
easy for Electron, Node, Python, Go and C clients.

ALTERNATIVES: localhost TCP, localhost HTTP, WebSocket.

TRADEOFF: browsers need a separately installed companion bridge. Windows pipe
DACL must be verified (threat model T3).

## D3. Length-prefixed JSON frames, zod-validated

DECISION: frame = 1-byte kind + uint32 BE length + payload; kind `0x01` JSON,
`0x02` reserved for binary. Schemas in zod with `.strict()`.

WHY: bounded parsing from the header; debuggable; zod is already a
dependency with Signal wrappers (`ts/util/schemas.std.ts`); room for binary
attachment chunks without base64.

ALTERNATIVES: newline-delimited JSON (unbounded line reads), protobuf via
protopiler (generated, Signal-internal, harder for third parties),
MessagePack (new dependency).

TRADEOFF: JSON overhead; acceptable at local IPC rates.

## D4. Version negotiation in the first message

DECISION: client `hello` lists supported versions; server picks the highest
common one or fails with `UNSUPPORTED_VERSION` and closes. Features are
advertised as capabilities and flags, never inferred from Signal's version.

## D5. Ed25519 client keys with challenge-response

DECISION: clients authenticate by signing a server nonce bound to the session
id; Signal stores only public keys. Signal also signs the handshake with a
server key that clients pin.

WHY: no access-granting secret stored by Signal; mutual authentication
defeats endpoint squatting; `node:crypto` provides Ed25519, so no new
dependency and no home-grown crypto.

ALTERNATIVES: bearer token issued at approval; OS peer credentials
(`SO_PEERCRED`, pipe client PID) which Node does not expose.

TRADEOFF: clients must manage a keypair (a few lines in any language).

## D6. Grants and enablement in SQLCipher, written only by main

DECISION: `items.externalClientGrants` and `items.externalClientsEnabled`,
removed on unlink.

WHY: plaintext config files are writable by any same-user process; a grant
there would be forgeable.

ALTERNATIVES: `ephemeral.json`, a separate JSON file.

TRADEOFF: listener cannot start until the DB is open; acceptable because no
method can be served before then anyway.

## D7. Off by default, no listener when off

DECISION: no endpoint, discovery file or socket exists unless enabled.
Unpackaged dev builds may set `SIGNAL_ENABLE_EXTERNAL_CLIENTS=1`.

## D8. Snapshot + event stream + resnapshot

DECISION: no cursor/sequence machinery over Signal state in v1. Per-session
event `seq` only detects gaps; on gap the client resnapshots.

WHY: Signal has no change log; inventing one is out of proportion.

## D9. Mark-read from an external client bypasses the window-active gate

DECISION: `messages.markRead` calls `ConversationModel.markRead` directly, not
the Redux `markConversationRead` thunk that returns unless Signal's window is
active. Requires the separate `messages.markRead` capability.

WHY: the external client is the surface the user is looking at.

TRADEOFF: Signal trusts the client's claim that the user saw the messages.
Must be visible in review.

## D10. No notification changes in v1 (superseded by D22)

Superseded on 2026-10-09 by D22. Original text, kept for the record:
v1 leaves Signal's notification logic alone and documents that clients should
not raise their own Signal notifications by default, because Signal has no
per-conversation visibility signal and a `presence.set` design needs upstream
agreement.

## D11. Send refuses instead of prompting

DECISION: external send returns `PRECONDITION_FAILED` with a reason
(untrusted identity, pending message request, blocked, not a member,
announcement-only, terminated, too long) instead of opening Signal's
safety-number modal or implicitly accepting a message request.

WHY: a remote UI must not cause trust decisions to be made silently or in a
window the user is not looking at.

## D12. Milestone A is main-only and needs no UI

DECISION: Milestone A ships `hello`/`disconnect` only, enabled by the DB item
or the dev env var. No renderer changes.

WHY: proves transport, framing, versioning and lifecycle in isolation, and is
the cheapest piece to review.

## D13. Native dialog for the Milestone B approval prompt

DECISION: approval uses `dialog.showMessageBox` modal to the main window, Deny
as default and cancel, all-or-nothing on the requested capabilities.

WHY: no new window, preload or React surface to review; the dialog cannot be
scripted by the requesting client. A per-capability window can replace it
without protocol changes.

## D14. Mutual handshake signatures, client nonce required

DECISION: `hello` requires `clientNonce`; the server signs it with its
persistent Ed25519 key. Client and server transcripts use distinct labels.

WHY: lets a client that pinned the server key reject a squatter on first
response, before sending anything sensitive.

## D15. Offset cursor for conversation lists

DECISION: `conversations.list` uses an opaque decimal offset cursor over the
left-pane ordering, max 500 per page.

WHY: the list is small and already sorted in memory; a stable keyset cursor
adds complexity without benefit until change events exist (D8).

## D16. Message cursor is a message id

DECISION: `messages.list` pages backwards with the id of the oldest row read
as the cursor; Signal looks up its `(received_at, sent_at)` like the
timeline does.

WHY: reuses Signal's own paging query unchanged; the id reveals nothing a
`MessageDTO` does not already carry.

## D17. Redact rather than omit hidden messages

DECISION: deleted, erased and view-once messages are returned with their
kind and timestamps but no content; expired disappearing messages and
non-chat rows are omitted.

WHY: clients can show "This message was deleted" or "View-once media" the
way Signal does without ever holding the content; expired messages are about
to be removed by Signal anyway.

## D18. Events: coalesced in the renderer, conversations by Redux diff

DECISION: message events come from three one-line hooks in Signal's message
code; conversation events come from diffing Redux's `conversationLookup`.
The renderer keeps one pending event per object and builds DTOs only when
it sends.

WHY: the message hooks are the existing choke points (architecture §2.9).
Conversations change through many paths, all of which end in Redux, so a
diff catches every one without touching them. Coalescing keeps a burst
(receipts, reactions, downloads) to one event per object.

## D19. Drop and resynchronize instead of buffering

DECISION: when a client falls behind, the renderer queue overflows, or the
renderer reloads, subscribers get `events.dropped`, lose their topics, and
must resubscribe and resnapshot. No replay buffer.

WHY: follows D8. Signal has no change log to replay from; a bounded drop
with an explicit signal is simpler to reason about than an unbounded or
lossy buffer, and the client already knows how to snapshot.

## D20. A Signal remote-config flag gates the bridge

DECISION: the bridge runs only when both Signal's remote-config flag
(`desktop.externalClients.beta` / `.prod`) and the user's opt-in are on.

WHY: Signal can roll it out gradually and switch it off centrally without a
release, the way other Desktop features ship. It is an extra gate, never a
substitute for the user's consent.

## D21. Sending ships in the first upstream PR

DECISION: the first PR includes `messages.sendText`, `messages.markRead` and
the notification hand-off. There is no read-only first PR.

WHY: the point of the bridge is that the user can keep Signal minimized in
the tray and work entirely in the client. A read-only bridge still needs
Signal's window open to reply, so it does not deliver that. Decided by the
project owner on 2026-10-09.

TRADEOFF: a bigger first review. Sends go through Signal's own send path and
refuse instead of prompting (D11), which keeps the new surface small.

## D22. Notification hand-off, opt-in per client

DECISION: a client holding `notifications.manage` can call
`notifications.setHandled { handled: true }`, but only while it is
subscribed to the `messages` topic (otherwise `PRECONDITION_FAILED`). While any connected client has
it set, Signal does not show message, reaction or unread-reminder
notifications. Call notifications are unaffected. The hand-off ends when the
client sets it back, unsubscribes from `messages`, has its events dropped,
disconnects, the bridge stops or the grant is revoked, so a client can never
hold notifications without receiving the messages it would notify about.

WHY: with the client as the user's surface, Signal minimized to the tray
would otherwise notify for every message the client already shows, so the
user gets two notifications for one message. This is the narrow piece of the
`presence.set` idea that clients need; it does not claim which conversation
is visible.

TRADEOFF: a client that sets the flag and then shows nothing hides
notifications. It needs a capability the user approved by name, and the
effect ends with the connection, so a crashed client cannot leave Signal
silent.

## D23. Settings: one toggle and an approved-apps list in Privacy

DECISION: Settings, Privacy gets an "Apps on this computer" section, shown
only when the remote-config flag (D20) is on: a switch for
`externalClientsEnabled` and the approved apps, each with Remove and a
confirmation. Remove revokes the grant and disconnects the app.

WHY: the user must be able to turn the bridge on without developer flags,
see what they approved and take it back.

## F1. Fork only: photos, author details, reactions and replies

Not part of the upstream proposal (PR #8054); on the fork's main only, on
the assumption that upstream never takes them (Mike, 2026-10-10).

DECISION: `conversations.getAvatar` returns a conversation's photo, decoded
inside Signal and re-encoded at 128 px, under `conversations.read`; it also
accepts direct conversations that are not listed, because group senders
usually have none. `ConversationDTO` gains `avatarColor` and an opaque
`avatarVersion` (a hash of the local URL, never the path or key).
`MessageDTO` and `QuoteDTO` gain `author` (title, avatar, and in groups the
member's name color and label); `ReactionDTO` gains `fromMe`.
`messages.react` (capability `messages.react`) reacts as Signal's reaction
bar does and is refused wherever sending would be (D11), since a reaction
would otherwise accept a message request. `reactions.getPreferred` returns
the user's quick-reaction bar. `messages.sendText` takes an optional
`quoteMessageId` in the same conversation.

WHY: Mike uses the Rambox page instead of Signal's window, so it has to
look and act like Signal; the goal is every Signal Desktop feature.

## F2. Fork only: attachment content

DECISION: capability `attachments.read` (approved by name, "See photos,
videos and files in your messages") with `attachments.getThumbnail` (a
preview re-encoded inside Signal, at most 640 px), `attachments.read`
(decrypted content in chunks of at most 512 KB at an offset, through the
timeline's own range-capable URL) and `attachments.download` (what clicking
a not-yet-downloaded attachment does). `AttachmentMetadataDTO` gains
`state`, `hasThumbnail`, `isVoiceMessage`, `isGif`, `caption` and
`blurHash`; `MessageDTO` gains `sticker`. A target is reachable only when
the message's DTO shows it, so view-once, deleted and erased content never
crosses, as in D7.

Amended 2026-10-10: `attachments.getThumbnail` draws from the full image
(Signal's small thumbnail only as a fallback) and takes an optional `width`
in device pixels (at most 1600), because a 640 px preview of a tall
screenshot was unreadable on a scaled display.

WHY: "open Signal to view" is not acceptable for a client that replaces
Signal's window (Mike, 2026-10-10).

## F3. Fork only: chat list, rich text, link previews, edit and delete

DECISION: `ConversationDTO` gains `lastMessage` (the chat list's preview
line, mentions written out) and `pinnedIndex` (the position in Signal's
`pinnedConversationIds`); a change in pin order re-sends every
conversation. Note to Self is always listed. `MessageDTO` gains
`formatting` (bold, italic, strikethrough, monospace, spoiler ranges),
`previews` (link preview title, description, domain, and whether an image
exists; the image comes through `attachments.getThumbnail` with
`preview: <index>`), and `canEdit` / `canDeleteForEveryone`, computed with
Signal's own rules. `MentionDTO` gains `title`. `messages.edit` and
`messages.delete` (`forEveryone` or only for this device and linked ones)
use the `messages.send` capability, and go through Signal's own edit and
delete paths.

WHY: Mike asked for Signal's pinned order, Note to Self in search, link
preview cards, and every Signal Desktop feature (2026-10-10).

## F4. Fork only: sending attachments, and forwarding without limits

DECISION: `attachments.uploadBegin` / `attachments.uploadChunk` take a file
in order, in chunks of at most 512 KB, into memory in Signal's renderer
(unsent uploads expire after 10 minutes; all of them together are capped at
512 MB). `messages.sendText` takes `attachmentUploadIds`; the body is then
the caption and may be empty. Signal processes each file exactly as its
composer does (`processAttachment`, draft, `enqueueMessageForSend` with the
user's media-quality setting), and refuses a file over its own size limit
for that type (`attachmentTooLarge`). `messages.forward` forwards a message
as Signal's Forward does (`maybeForwardMessages`) to any number of chats
(up to 5000 per call) and returns a result per chat; each chat is refused
on its own for the same reasons sending would be, so the safety-number
dialog never opens (D11). All of these use the `messages.send`
capability. Renderer calls for sending and forwarding may take up to 120 s.

WHY: Mike pastes images into chats all day; and Signal's five-chat forward
limit is why his Signal-Forwarder exists, so this one has no limit and lists
every chat by most recent activity (2026-10-10).

## F5. Fork only: the full emoji picker and recently used emoji

DECISION: `emoji.getCatalog` (capability `messages.react`) returns Signal's
picker categories in Signal's order with short names and the user's skin
tone applied; `reactions.getPreferred` also returns Signal's recently used
emoji (`recent`). A reaction outside the quick-reaction bar is recorded as
used, as Signal's picker does, and `emoji.markUsed` records an emoji
picked for the composer. Signal keeps this list per device and does not
sync it, so a fresh install starts empty.

WHY: Mike wants the ⋯ after the quick reactions and the recently used list,
as in Signal (2026-10-10).

## F6. Fork only: polls, and sending one poll to many chats

DECISION: messages carry `poll` (question, options with voters, our own
vote, ended, pending, canEnd), read the same way as Signal's timeline:
the newest sent vote per person counts, and our unsent vote shows as
pending. `polls.vote` (an empty list takes the vote back), `polls.end`
(our own open poll only) and `polls.send` use capability `messages.send`
and refuse where Signal would show a dialog (D11). `polls.send` takes up
to 5000 chats and creates a new poll in each; 1:1 chats are refused with
`pollsNotSupported` while Signal's 1:1 poll flag is off. Limits are
Signal's: 2 to 10 options, at most 100 characters (graphemes) for the
question and each option.

WHY: Mike asked for polls and "the ability to forward a poll to multiple
groups" (2026-10-10). Signal can't forward a poll (`canForward` excludes
them) because votes belong to one message, so the closest thing is the
same poll created in each chat. The page says each chat gets its own copy.

## F7. Fork only: @mentions

DECISION: `conversations.getMembers` (capability `conversations.read`) lists
the members Signal's mention list offers: a group's members with an ACI,
sorted by name, without us, each with the same author details messages
carry, and no phone numbers or service ids. `messages.sendText` and
`messages.edit` take `mentions: [{start, conversationId}]`; the body holds
U+FFFC at each `start`, exactly as Signal's composer sends it. Signal maps
each to the member's ACI itself and the call is refused if one is not at a
placeholder or names someone who isn't a member.

WHY: Mike tagged someone in a group from the page and nothing happened
(2026-10-10). Mentions notify the person and render as mentions for
everyone, which typed "@Name" text does not.

## F8. Fork only: sending text formatting

DECISION: `messages.sendText` and `messages.edit` take
`formatting: [{start, length, style}]`, style one of bold, italic,
strikethrough, monospace, spoiler (Signal's BodyRange styles, the same
names messages already carry). Offsets count UTF-16 units of the body.
Signal gets them as real body ranges alongside any mentions; a range past
the end of the body is refused. The page's message box is editable HTML
(plain-text editing, so the browser adds no markup of its own) and offers
Signal's styles three ways: a right-click menu on selected text (Cut, Copy,
Paste, then the five styles with checkmarks; Shift+right-click gives the
browser's menu), a bar above selected text, and Signal's shortcuts (Ctrl+B,
Ctrl+I, Ctrl+Shift+X, Ctrl+E, Ctrl+Shift+B). Pasted text comes in plain.
Editing a message loads its styles and mentions back into the box.

WHY: Mike asked for Bold, Italic, Strikethrough and Spoiler on right-click
(2026-10-11 22:14 PT); Monospace, the bar and the shortcuts make it match
Signal's own composer. Styles sent as body ranges render for every
recipient, which Markdown-ish text would not.

## F9. Fork only: delivery status in the chat list

DECISION: `lastMessage.status` on conversations carries Signal's own
status for the user's last message (the same values as a message's
`sendStatus`; null for someone else's message). The page shows Signal's
icons (images/icons/v3/message_status, served by the helper) at the end of
the preview line and in each outgoing bubble in place of the words: one
circled check sent, two delivered, two filled read or viewed, a spinner
while sending, a red "!" when not sent (bubbles keep the words for
problems). The words stay as each icon's tooltip.

WHY: Mike wants to see from the list who has read a message, as Signal
shows it (2026-10-11 22:37 PT), after forwarding to 28 chats.

## F10. Fork only: sending stickers

DECISION: `stickers.getPacks` lists the user's installed packs in Signal's
order (id, title, author, cover and each sticker's id and emoji; never a
pack key) and Signal's Recently used stickers. `stickers.getImage` draws a
sticker from Signal's own decrypted copy, as thumbnails are drawn, and only
for a sticker the picker offers (an installed pack or Recently used).
`messages.sendSticker {conversationId, packId, stickerId}` sends through
Signal's own `sendStickerMessage`, which also moves the sticker to Recently
used, and is refused per D11. All three need `messages.send`, so no new
approval. The page has a sticker button by the message box that opens a
picker with Recently used and one tab per pack; picking a sticker sends it,
as in Signal. Installing packs stays in Signal.

WHY: Mike found stickers could be seen but not sent (2026-10-11 23:28 PT).

## F11. Fork only: Settings, and the emoji skin tone

DECISION: A new capability, `settings.manage` (one more line in Signal's
approval dialog), allows `settings.get` and `settings.set {key, value}`
for a fixed list of Signal's settings, each changed the way Signal's own
Settings page changes it (state/smart/Preferences.preload.tsx), so the
account-wide ones sync to the phone and other devices:

- Chats: default emoji skin tone, link previews, sent media quality, and
  keep muted chats archived.
- Notifications: notification content and sound (the page's own
  notifications follow both), and reaction notifications.
- Privacy: read receipts, typing indicators, the default disappearing
  timer, who can see and who can find my number (with Signal's rule that
  "everyone can see" makes it findable), and the sealed sender status icon.
- Data usage: media auto-download.

The page has a Settings dialog with Signal's sections, plus Appearance
(the page's light/dark/system theme, kept in the browser), and a skin tone
button in the emoji picker. Unlinking devices, deleting data, changing
number and backups stay in Signal, so a browser tab can't lock Mike out.
Desktop-window settings (launch at login, tray, zoom, spell check) don't
apply to a computer without a screen and are left out. Stories on/off came
later, in F12.

WHY: Mike needed the emoji skin tone and asked for the whole Settings menu
(2026-10-12 09:44 PT).

## F12. Fork only: profile, blocked list and stories on/off

DECISION: Under the same `settings.manage` capability (no new approval):

- `profile.get` returns our name, about (text and emoji), username and
  photo version (our own conversation, Note to Self, carries the photo).
- `profile.set {firstName, familyName, aboutText, aboutEmoji}` saves
  through writeProfile, as Signal's profile editor does, with its limits:
  a required first name, names up to 26 characters (128 bytes), about up
  to 140 characters (512 bytes), and the emoji must be one Signal knows.
- `profile.setAvatar {data}` takes an image (base64, up to 600 KB) and
  Signal re-encodes it as a centered square JPEG of at most 512 px, as its
  avatar editor does; `null` removes the photo. The page crops and shrinks
  the picture in the browser first and posts the bytes to
  `api/profilePhoto`.
- The username is shown, not changed: Signal's username flow reserves and
  confirms with its server and belongs in Signal itself.
- `settings.get` adds `blocked` (people, then groups, as Signal's Privacy >
  Blocked page builds it, with the date when Signal has one) and
  `storiesEnabled`. The blocked list is read-only, as in Signal; a chat is
  unblocked from the chat.
- `settings.set {key: 'storiesEnabled'}` turns stories on or off. Turning
  them off deletes the stories we shared first, as Signal's confirmation
  says, and the page asks with the same words. (Signal Desktop's own code
  calls deleteAllMyStories when turning stories back on, which looks
  inverted; the fork follows the dialog's promise.)

WHY: The promised second round of Mike's "replicate the entire Settings
menu" (2026-10-12).

## F13. Fork only: reading a chat clears "mark as unread"; quotes jump

DECISION: `messages.markRead` also clears a manual "mark as unread"
(setMarkedUnread(false)), as Signal does when a chat is opened; before,
such a chat kept its dot no matter what. The page asks Signal to mark the
open chat read when it opens, when messages arrive, when the tab gains
focus, when the reader scrolls to the newest message or clicks in the
page, and once more after a call that was in flight when another was
asked for. A click on a reply's quote scrolls to the original (found by its
sent time and author), loading older pages as needed, and flashes it; if
it isn't there, the page says "Original message not found", as Signal.

WHY: Mike (2026-10-12 18:20 PT): some chats stayed unread after reading
them, and Signal's quote jump was missing.

## F14. Fork only: typing indicators

DECISION: The vocabulary's `typing.read` and `typing.send` capabilities are
now implemented (two more lines in Signal's approval dialog).

- Topic `typing` (needs `typing.read`) sends `typing.changed {conversationId,
typists: [{authorConversationId, author}]}` whenever the people typing in
  a listed chat change, read from the same Redux state Signal's timeline
  uses; an empty list means nobody is. Whoever is typing at subscribe time
  is sent first.
- `conversations.setTyping {conversationId, typing}` (needs `typing.send`)
  calls Signal's own throttledBumpTyping, so Signal refreshes, pauses after
  three seconds and sends nothing while the typing indicators setting is
  off; `false` stops at once (the draft was cleared).
- The page shows Signal's dots in the chat list and a typing bubble (with
  the typists' photos in groups) under the last message, and reports typing
  at most once a second while the draft is non-empty.

WHY: The first gap on Mike's standing parity rule (2026-10-13).

## F15. Fork only: Signal's chat menu

DECISION: A new capability, `conversations.manage` (one more line in
Signal's approval dialog), allows `conversations.update {conversationId,
change}`, where `change` is one of Signal's chat menu actions: mute (for a
duration, or always), unmute, pin or unpin (Signal's limit of four pinned
chats answers PRECONDITION_FAILED), archive or unarchive, mark as unread,
set the disappearing messages timer, block, accept (which is also how
Signal unblocks) and delete chat. Each dispatches the same Redux action as
Signal's header menu or chat-list context menu, so it syncs to the phone
the same way. ConversationDTO gains `mutedUntil`, `disappearingSeconds` and
`canChangeTimer`.

The page has a menu button in the chat header and a right-click menu on
chat list rows, with Signal's mute and timer choices; an "Archived chats"
view at the end of the list; and Signal's bar for message requests and
blocked chats (Accept, Block, Delete / Unblock, Delete) in place of the
composer. Block, unblock and delete ask first with Signal's own words.

WHY: The second gap on Mike's standing parity rule (2026-10-13).

## F16. Fork only: chat details and members

DECISION: Signal's existing `contacts.read` capability (offered in the
approval dialog since the proposal, never implemented) is now implemented
by `conversations.getDetails {conversationId}`. It answers what Signal's
chat details panel shows: for a person, profile name, nickname and note,
about, phone number, username, safety-number verified, whether they are in
your system contacts, and groups in common; for a group, its description,
members (you first, then by name, with admins marked), pending and
requesting counts, whether you are an admin and may edit info or add
members, and the group link (admins only, as in Signal). It reads Signal's
Redux state, so it is exactly what Signal's own panel would show.

The page opens a details dialog from the chat header (photo or name) and
from the chat menu ("About" / "Group details"), with a "Chat options"
button that opens the chat menu over it.

WHY: The third gap on Mike's standing parity rule (2026-10-13). Safety
numbers and group changes come later.

## F17. Fork only: message search

DECISION: `messages.search {query, conversationId?, limit?}` (needs
`messages.read`, no new approval) runs the same search as Signal's search
box: the full-text query, plus messages mentioning contacts whose names
match, across all chats or in one, newest first, up to Signal's own limits
(500, or 100 in one chat). Each result is the message as `messages.list`
gives it, with Signal's snippet and the matched words as ranges of its
body, so clients show them with the message's own mentions and styles.
`messages.list` gains `newer: true`, which pages forward from the cursor,
so a client can open a chat at an older message and fill in toward the
newest.

The page searches messages as you type in the search box, listing them
under the matching chats as Signal does ("Alice in Family", the snippet
with the match in bold). A result opens its chat at that message, with the
messages around it; scrolling down loads newer ones, and sending goes back
to the newest. The chat menu has "Search in chat".

WHY: The fourth gap on Mike's standing parity rule (2026-10-13).

## F18. Fork only: the unread line

DECISION: Page only, from what the bridge already gives (`unreadCount`,
`read` on incoming messages). Opening a chat with unread messages loads
back to the oldest unread one (up to 20 pages), puts Signal's "N Unread
Messages" line above it and opens there; the line stays until the chat is
opened again. The chat is marked read only once you've scrolled down to
the newest message (Signal's rule), not on opening. Signal's round button
down to the newest message, with the unread count, shows whenever you're
scrolled up.

WHY: Mike, 2026-10-13 09:42 PT: "when you go into a chat / thread, it puts
a line before the first unread message, so you know where to start."

## F19. Fork only: recording voice notes

DECISION: `attachments.uploadBegin` takes an optional `voiceNote
{durationSeconds, waveform}` (an audio type, no file name; no new
capability). Signal then builds the attachment exactly as its own recorder
does (completeRecording in ducks/audioRecorder): the voice message flag,
the waveform and the duration, without the file processing other uploads
get.

The page records with Signal's own encoder, the mp3Encoder audio worklet
Signal Desktop records with (90 kbps MP3, its waveform and level meter),
which the signal-headless image copies next to the page. Recording looks
like Signal's: cancel, a red dot, the time, the live level and Send; Escape
cancels, Signal's one-hour limit stops it, and leaving the window or the
chat keeps it as a draft to play, send or discard. The page needs the
microphone, so the browser (Rambox) asks the first time.

WHY: Next gap on Mike's standing parity rule (2026-10-13).

## F20. Fork only: new chats and new groups

DECISION: Signal's compose button. `contacts.list {forGroup?}` (needs
`contacts.read`, whose approval line now says "See your contacts and chat
details") returns the people Signal's "New chat" or "New group" list
offers (the same selectors), with about, username and phone number only
where Signal shows them. A new capability, `conversations.create` (one
more line in the approval dialog), allows:

- `conversations.find {query}`: a username (name.01) or phone number,
  looked up with Signal's own lookupConversationWithoutServiceId, so it
  asks Signal's server exactly as Signal's search does;
- `conversations.open {conversationId}`: a contact or group Signal's
  composer offers;
- `groups.create {name, memberIds, avatar?, disappearingSeconds?}`:
  Signal's createGroupV2, with its 32-character name limit, its member
  candidates and the profile photo's square JPEG for the photo.

The first two and a new group return the chat, which then works with
messages.list and messages.sendText before it has any messages (as an open
chat in Signal) and joins the list with its first message.

The page has Signal's pencil button by the search box: "New chat" lists
"New group", Note to Self and your contacts, and finds a typed username or
number; "New group" picks members (with chips), then name, photo and
disappearing messages timer.

WHY: Next gap on Mike's standing parity rule (2026-10-13).

## F21. Fork only: group management

DECISION: Signal's group details page. A new capability, `groups.manage`
(one more line in the approval dialog: "Change your groups: name, photo,
description, members, admins, group link and permissions, and leave
groups"), allows `groups.update {conversationId, change}`, where `change`
is one of Signal's group changes: `setInfo` (name, description, photo or
null to remove), `addMembers`, `removeMember`, `setAdmin`,
`approveRequest`, `denyRequest`, `revokeInvites`, `groupLink`,
`resetGroupLink`, `groupLinkApproval`, `permissions` (add members, edit
info, send messages: all or admins) and `leave`.

Each calls the same ConversationModel method or modifyGroupV2 builder
Signal's controls use, but directly rather than through the Redux actions,
which wrap them in longRunningTaskWrapper: on the headless Signal its
error dialog would stay open with nobody to close it, and the app needs the
failure back. The checks Signal makes before offering a control come
first (admin, canEditGroupInfo, canAddNewMembers, the last admin can't
leave, own invites for non-admins, announcement-capable groups), with
Signal's 32 and 480 grapheme limits; Signal's group server checks again.

`conversations.getDetails` gains what the page shows: invites (named only
when you sent them; others' as a count per inviter, as Signal), requests
to join (admins only), whether the link is on and needs approval, the
three permissions, whether "only admins send" is offered, and whether you
can leave. The group link is now shown only while it is on.

The page's group details gain Edit group (name, description, photo), Add
members (the compose dialog's member picker), a menu on each member for
admins (Make or Remove admin, Remove from group), Requests to join
(Approve, Deny), Invited (Revoke), the Group link section (on/off, copy,
approve new members, reset) and Permissions, and Leave group.

WHY: Next gap on Mike's standing parity rule (2026-10-13).

## F22. Fork only: the name Backchannel

DECISION: The Docker kit and helper are renamed Backchannel (Mike,
2026-10-13), since Signal guards its trademark and others will want to run
this. `contrib/signal-headless` is now `contrib/backchannel` and
`contrib/signal-rambox` is `contrib/backchannel/helper` (entry point
`backchannel.mjs`). The image, Compose project and service are
`backchannel`; the page's title is "Backchannel" with its own icon; the
helper asks Signal's approval as "Backchannel". The READMEs say it is not
made or endorsed by Signal Messenger and use "Signal" only to say what it
works with.

No prebuilt image is published: a prebuilt image would redistribute a
modified, Signal-branded Signal Desktop. People build it from this
repository on their own machine.

Existing installs keep working: Compose still reads `SIGNAL_UID`,
`SIGNAL_DATA` and `RAMBOX_ORIGIN`, and the helper moves its old
`signal-rambox` config folder to `backchannel` on start, keeping the page
token and the approved key. Grants are kept per key, so Signal doesn't ask
again for capabilities it already granted.

WHY: Mike's call on the name, from a short list; publishing the kit for
others.

## F23. Fork only: contact cards and "Reply privately"

DECISION: In a group, clicking a sender's photo or name opens their card
(the details dialog's About, as Signal's contact modal) with a Message
button. `conversations.getDetails` and `conversations.open` now also take
a person who is in a group the client can see, even with no chat yet, so
Message opens or starts the chat (Signal's contact modal does the same).

"Reply privately" (Mike, 2026-10-13; Signal has no such option, people
forward or copy instead) is in a group message's menu for messages from
others. It opens the direct chat with the sender and quotes the group
message. `messages.sendText` accepts that one cross-chat quote: the quoted
message must be an incoming message in a group the client can see, sent by
the person the direct chat is with. Signal sends it as an ordinary quote
(author, sent time, text), so the other person's Signal shows the quoted
text with "Original message not found", since Signal only links quotes
within one chat.

On this page it links both ways. The helper remembers each private reply
sent from the page (`private-replies.json` in its config folder: group
chat and message, direct chat and reply, nothing else), so the reply's
quote says "Replied privately from <group>" and jumps to the group
message, and the group message shows "You replied privately", which jumps
to the reply. For quotes it didn't record, a new `messages.locateQuote
{messageId}` (needs `messages.read`) asks Signal where the quoted message
is: in the same chat, or in a group the client can see.

WHY: Mike's request; it only works for members of the group, which the
checks above enforce.

## F24. Fork only: a separate public repo for Backchannel

DECISION: github.com/mikesimone/backchannel is the public front door:
README, screenshots, setup, releases and issues. The code stays here,
because almost every feature changes the bridge and the page together. Its
compose.yml builds this repository at a release tag
(`backchannel-vX.Y`, Docker's git build context), so users get a version
that ran on Six, not main. Six itself keeps building from this fork's main.

WHY: Mike asked how people would find a folder inside a Signal fork
(2026-10-13 12:28 PT) and deferred to judgement on a new repo.

## F25. Fork only: quoted attachments and their thumbnails

DECISION: `QuoteDTO.attachment` describes the quoted message's first
attachment the way Signal's quote does (content type, file name, voice
message, GIF, and whether a thumbnail exists), never for view-once.
`attachments.getThumbnail` with `quote: true` renders the quote's own
thumbnail, the small image Signal stores with the reply, so it works even
when the original isn't loaded. The page shows "Photo", "Video", "GIF",
"Voice message", "Audio" or the file name, with the thumbnail on the
right, in bubbles and in the reply bar.

WHY: Mike asked (2026-10-13 12:47 PT); quotes of photos read "Attachment".

## F26. Fork only: no approval dialog before Signal is linked

DECISION: `authorization.request` from a key without a grant answers
`NOT_READY` ("Signal is not linked") while Signal is unlinked, instead of
showing the approval dialog. The helper retries every 5 seconds, shows
"Link Signal to your phone first", and logs the wait once.

WHY: On a new install the helper asked at once, and Signal's dialog
covered the link QR code, so nobody could link (found by the Backchannel
repo's build check, 2026-10-13). Linking first is also the sensible order:
decide whether to trust an app once Signal is yours.

## F27. Fork only: sending link previews

DECISION: `linkPreviews.fetch {text, exclude?}` (under `messages.send`, as
part of writing a message) finds the first link Signal's composer would
preview and has Signal fetch it with the composer's own code
(`getPreview`, now exported from services/LinkPreview), honoring the link
previews setting. It returns the title, description, domain and a small
rendering of the image. Signal keeps the full result for ten minutes, and
`messages.sendText {linkPreviewUrl}` attaches it exactly as the composer's
getLinkPreviewForSend would: not when previews are off, the link is gone
from the body, or the message has attachments. The page shows the card
above the message box with an × that skips that link.

WHY: Mike noticed links went out bare (2026-10-13 13:11 PT). In Signal the
sender attaches the preview; recipients never build one.

## F28. Fork only: sticker replies

DECISION: `messages.sendSticker` takes an optional `quoteMessageId`, checked
like `messages.sendText`'s (same chat, or "Reply privately"), and passes the
quote to `sendStickerMessage`, as Signal's composer does behind its
`desktop.stickerReply.send` remote flag. On the page, picking a sticker
while a reply is pending sends it as the reply.

WHY: Mike asked (2026-10-13 13:23 PT). Signal hasn't turned the flag on,
so some recipients' apps may show the sticker without the quote until it
does.

## F29. Fork only: scheduled messages

DECISION: the Backchannel helper keeps scheduled messages and sends them
through the bridge when they come due; Signal and the bridge are unchanged.
They live in the helper's config folder (`scheduled.json` and
`scheduled-files/`, mode 600, at most 500 messages and 100 MB per file),
with the text, mentions, styles, quote, link preview and files as they were
when scheduled. A check runs at least once a minute; a message whose time
passed while the helper or Signal was down goes out once both are back, as
on Signal Android. Signal-side refusals that a retry can't fix (chat gone,
not allowed, invalid) mark it "not sent" for the user to reschedule, send
now or delete; anything else waits for the next check. On the page, hold or
right-click Send to schedule (this evening, tomorrow 8 AM, next Monday 8 AM,
or a chosen time), and a clock by Send lists the chat's. A private reply
can't be scheduled.

WHY: Mike asked (2026-10-13 13:28 PT). Signal Desktop has no scheduling and
Signal's protocol has none server-side (Android keeps them on the phone),
so something running has to hold them; the helper already runs next to
Signal, and on a server it sends while every other device is off. Keeping
them in Signal's database would need a new bridge surface for no gain: the
database key sits on the same disk.

## F30. Fork only: stepping through a message's photos

DECISION: the Backchannel viewer steps through the photos and videos of the
message it was opened from: on-screen arrows, the Left and Right keys, a
swipe on touch screens, a "2 of 5" count and a thumbnail strip to jump to
one. Each keeps its caption and Save button; leaving a video stops it; the
neighbouring photos load ahead. Page only.

WHY: Mike asked (2026-10-13 14:56 PT). Signal's viewer also pages on
through the rest of the chat's media; that needs the media gallery, which
is still missing, so it comes with that.

## F31. Fork only: all media

DECISION: `media.list {conversationId, kind, cursor?, limit?}` (under
`messages.read`) lists a chat's photos and videos, audio, files or links,
newest first, with Signal's own media-gallery queries (getSortedMedia,
getSortedDocuments without shared contacts, getSortedNonAttachmentMedia
for links). Items are `{messageId, index}` (the attachment's, or the
preview's for links) with the messages they're in, as `messages.list`
gives them, so the page reuses its thumbnails, players, files and link
cards. Pages end on whole messages: the cursor is a message's received and
sent times, as Signal's loadMore uses. The page's "All media" (chat menu
and details) has Signal's tabs (Media, Audio, Links, Files) grouped by
month, with "Show in chat" on every item and in the viewer.

The viewer opened from the gallery steps only through that message's
photos, as from the chat (F30), not across the chat's media as Signal's
does: Mike's preference (2026-10-13 17:05 PT).

WHY: Mike asked (2026-10-13 17:05 PT); it was the largest missing view on
the parity list.

## F32. Fork only: editing and tagging when forwarding

DECISION: `messages.forward` takes an optional `edit {body, mentions?,
formatting?, attachmentIndexes}`: the text as edited in the dialog (Signal's
Forward also lets you edit it), the original's attachments to keep, and
@mentions, which Signal's Forward doesn't offer. Because one forward goes to
many chats, each chat gets its own text: a mention stays a mention where
that person is a member of the group, and becomes "@Name" text elsewhere,
with styles moved to match (`forwardEdit.std.ts`). Chats that end up with
the same text are sent together. A link preview stays only while its link
is in the text. Stickers and shared contacts can't be edited. Without
`edit`, a forward is exactly Signal's.

The page's Forward dialog has the message box's editor (styles, the format
menu and bar, the @ picker offering members of every group picked) and the
attachments with a remove button; it says where a tag will notify.

WHY: Mike asked (2026-10-13 17:06 PT).

## F33. Fork only: markdown shortcuts and Unicode-styled copies

DECISION: In the page's message boxes, typing a closing mark applies
Signal's own style to the text between the marks and removes them: \*bold\*,
\_italic\_, \~strikethrough\~, \`monospace\`. Marks nest, so \_\*text\*\_ is
bold italic. The opening mark must not follow a letter or digit, and the
text must not start or end with a space, so 2\*3\*4 and snake_case stay as
typed. Backspace right after a conversion restores the marks. What is sent
is Signal's formatting (body ranges), not special characters, so it stays
searchable and readable by screen readers on every Signal app.

Copying styled text (Copy text in a message's menu, or a selection within
one message or in the message box) puts plain text on the clipboard with
the styles written in Unicode's mathematical sans-serif letters (bold,
italic, bold italic, monospace) and a combining stroke (U+0336) for
strikethrough. Only A to Z and 0 to 9 have such letters; other characters
and spoilers copy plain. Pasting into the page reverses it, serif letters
included, into Signal's styles.

WHY: Mike asked (2026-10-14 15:16 PT) for formatting that survives a paste
into an SMS, as yaytext.com does, and for markdown shortcuts. He chose
real formatting over sending Unicode letters (2026-10-14 15:47 PT).

Update (Mike, 2026-10-15 09:24 PT): marks already in pasted text apply as
it lands, and any pair still in the text applies when it is sent or
scheduled, with the same rules. Text inside a link, or already monospace, is
left as it is.

## F34. Fork only: chat folders, and the unread filter in search

DECISION: `chatFolders.list` (conversations.read, so no new Allow) returns
Signal's chat folders in Signal's order, with each folder's rules: all 1:1
chats, all groups, chats added or left out, unread only, and whether muted
chats show. As in Signal's chat list, it returns none until you have a
folder of your own. The page then shows those folders as the tabs over the
chat list, with unread counts, and matches chats to them as Signal does;
with no folders it keeps All, 1:1 and Groups. Folders are made and edited in
Signal for now; the page picks up changes when you come back to it.

`messages.search` takes `onlyUnread`, Signal's own unread filter for
search (Signal 8.32). With the unread filter on, the page's search across
chats finds unread messages only, and message results follow the current
tab.

WHY: the weekly parity check (2026-10-19) found Signal 8.32's note that the
unread filter now works in folders and search; chat folders themselves were
missing from the parity list.

## F35. Fork only: "Safety number changed" and Send anyway

DECISION: when Signal refuses a send because someone in the chat has a new
safety number, the page shows Signal's own dialog: who changed, with Cancel
and Send anyway. `safetyNumbers.changed` (conversations.read) lists those
people; `safetyNumbers.accept` (new capability `identity.manage`) accepts
only the ones the user was shown and still untrusted, as Signal's dialog
does, and the page then sends again. This amends D11: the bridge still never
accepts anything on its own, but the user can now make the choice in the
page instead of on their phone. Viewing and verifying the safety number
itself is still missing.

The main process also stopped dropping the refusal's reason, so every
refused send now says why in plain words instead of "PRECONDITION_FAILED".

WHY: Mike hit "Not sent (PRECONDITION_FAILED)" on a send to a chat where a
contact had reinstalled Signal (2026-10-19).

## F36. Fork only: importing contacts from the phone, and each chat's photo

DECISION: `contacts.sync` (settings.manage, so no new Allow) is Signal's
Settings > Chats > "Import contacts": it asks the phone to send its contacts
again and waits until contact sync has applied them, photos from the
phone's address book included. The page offers it in Settings and as
"Import photos from phone" in a chat's details.

`conversations.update` takes `photoSource` (auto, contact or profile): a
fork-only conversation attribute that Signal's own getAvatar honors before
the account-wide preferContactAvatars, so Signal Desktop and the page show
the same photo. It stays on this computer and does not sync to the phone.
Chat details report which photos Signal has for the person and which one
shows, so a chat with no photo says why.

WHY: Dan Mathews showed no photo although he is in Mike's phone contacts
with one (2026-10-19). Six had neither his profile photo nor the contact
photo: linked Signal imports contacts once, at linking (2026-10-10), and
the photo arrived on the phone later.

## F37. Fork only: contact photos first, and kept fresh

DECISION (Mike, 2026-10-19 15:35 PT): the photo from the phone's contacts
always comes first. Signal's getAvatar in this fork ignores
preferContactAvatars; only a chat set to "Signal profile" (F36) shows the
profile photo. The page offers just those two choices.

Contact photos are kept fresh, since a linked Signal can't read the phone's
address book, only what the phone sends:
- Before a new 1:1 chat opens from the page (conversations.find and
  conversations.open), Signal asks the phone for its contacts when the
  person has no contact photo yet, waiting at most 15 seconds and at most
  once a minute. The chat then opens with the name and photo from the
  phone's contacts.
- The helper asks once a day (and when Signal comes back after a day or
  more), and 30 seconds after someone new appears in a 1:1 chat, such as a
  first message from an unknown number, at most once in 10 minutes. The
  last time is kept in contact-sync.json in the helper's config.

WHY: Mike: "Nobody goes to the trouble of setting an individual contact
photo just to have it overwritten." New chats should look for the number
in his contacts first.

## F38. Fork only: block and unblock from Settings

DECISION: as Signal 8.35's Settings > Privacy > Blocked, the page's
Settings > Blocked lists who is blocked with an Unblock button each, and
"Add blocked user or group" picks from Signal's contacts and the groups in
the chat list. Both use conversations.update (block, accept), the same
Redux actions Signal's settings page dispatches, so no new Allow; each asks
first with Signal's own wording.

WHY: the weekly parity check (2026-10-26) found upstream's "Support
block/unblock from preferences".

## F39. Fork only: edit history

DECISION: "Edited" under a message opens its earlier versions, newest first,
with their formatting and mentions, as Signal's edit history dialog.
`messages.getEditHistory` (messages.read, so no new Allow) returns them, and
nothing for deleted or view-once messages, whose content never crosses.

WHY: next missing item on the parity list after the 2026-10-26 check.

