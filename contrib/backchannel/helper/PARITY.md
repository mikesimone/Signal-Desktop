# Parity with Signal Desktop

Standing rule (Mike, 2026-10-13): the Backchannel page does everything Signal
Desktop does, and keeps up as Signal adds features. This is the list. Each
built item has a decision (Fn) in
[docs/external-client-decisions.md](../../../docs/external-client-decisions.md).

Status: **done**, **partial**, **missing**, or **different** (on purpose).
A weekly check compares new Signal releases against this list and adds
what they bring.

Last reviewed: 2026-11-09, against Signal 8.37.0-alpha.1 in fork main (upstream main has nothing newer).

## Chat list

| Feature                                              | Status  | Notes  |
| ---------------------------------------------------- | ------- | ------ |
| Chats with photos, previews, times, unread counts    | done    | F1, F3 |
| Pinned chats in Signal's order                       | done    | F3     |
| All / 1:1 / Groups tabs, unread filter               | done    | F3     |
| Your chat folders as the tabs, with unread counts    | done    | F34    |
| Unread filter in folders and search                  | done    | F34    |
| Make, edit and reorder chat folders                  | missing |        |
| Delivery checkmarks on your last message             | done    | F9     |
| Drafts kept per chat                                 | done    |        |
| Filter chats by name                                 | done    |        |
| Archived chats view                                  | done    | F15    |
| Pin, unpin, archive, mute, mark unread from the list | done    | F15    |
| Search messages across chats                         | done    | F17    |
| New chat, find by username or number                 | done    | F20    |
| New group                                            | done    | F20    |
| Message requests (accept, block, delete)             | done    | F15    |

## Conversation

| Feature                                                  | Status    | Notes                                                |
| -------------------------------------------------------- | --------- | ---------------------------------------------------- |
| Messages, author names and colors, member labels         | done      | F1                                                   |
| Reactions, who reacted                                   | done      | F1, viewer                                           |
| Quoted replies with thumbnails, jump to the original     | done      | F1, F13, F25                                         |
| Edit and delete (for me, for everyone)                   | done      | F3                                                   |
| Photos, videos, GIFs, files, voice notes (play)          | done      | F2                                                   |
| Viewer: arrows, keys, swipe, thumbnail strip             | different | F30: one message, by choice; Signal pages the chat   |
| Long messages                                            | done      |                                                      |
| Polls (vote, end, create, send to many chats)            | done      | F6                                                   |
| Stickers (view and send)                                 | done      | F10                                                  |
| Sticker favorites                                        | missing   | Signal beta, behind a remote flag; 8.37 adds favoriting from a sticker message and the picker's menu |
| Link previews (view)                                     | done      |                                                      |
| Mark read as you read, clears "mark as unread"           | done      | F13                                                  |
| Unread line, jump-to-newest button with count            | done      | F18                                                  |
| Typing indicators (see them)                             | done      | F14                                                  |
| Disappearing messages (expire on time)                   | done      |                                                      |
| View-once media                                          | missing   |                                                      |
| Contact cards (view)                                     | done      | F41: numbers, emails, addresses, Message             |
| Payments, gift badges                                    | missing   |                                                      |
| Message details (per-recipient delivery)                 | missing   |                                                      |
| Edit history                                             | done      | F39                                                  |
| Chat header: details, members, safety number             | partial   | F16: details and members; safety number missing      |
| Contact card from a group member's photo or name         | done      | F23: About and Message                               |
| Reply privately to a group message                       | different | F23: beyond Signal; links both ways on this page     |
| Per-chat settings: timer, mute, block, colors, nickname  | partial   | F15, F46: timer, mute, block, nickname; colors missing |
| Media, files, audio and links gallery                    | done      | F31: viewer steps within one message                 |
| Search inside a chat                                     | done      | F17                                                  |
| Group management (add/remove, admins, link, name, photo) | done      | F21: also requests, invites, permissions, leave      |
| Poll-ended and other system notices                      | partial   |                                                      |
| Stories (view, post, reply)                              | missing   |                                                      |
| Calls (voice, video, group, call links)                  | missing   | needs a microphone and camera path into Signal       |

## Composer

| Feature                                            | Status    | Notes                                        |
| -------------------------------------------------- | --------- | -------------------------------------------- |
| Text, @mentions                                    | done      | F7                                           |
| Bold, italic, strikethrough, monospace, spoiler    | done      | F8                                           |
| Emoji picker with skin tones                       | done      | F5, F11                                      |
| Attach files, paste and drop images                | done      | F4                                           |
| Forward to any number of chats                     | different | F4: no limit of five                         |
| Forward: edit the text, drop attachments, @mention | different | F32: mentions are beyond Signal              |
| Stickers, also as replies                          | done      | F10, F28                                     |
| Send link previews                                 | done      | F27                                          |
| Scheduled messages                                 | different | F29: Desktop has none; the helper sends them |
| Record voice notes                                 | done      | F19                                          |
| Send contact cards                                 | done      | F41: name, photo, number, as Signal 8.34     |
| GIF search                                         | done      | F54: GIPHY through Signal's proxy            |
| Typing indicators (send them)                      | done      | F14                                          |
| Safety number changed                              | different | F40: accepted by itself, never stops a send  |
| Send view-once media                               | missing   |                                              |
| Sent media quality per message                     | missing   | the setting applies                          |

## Settings

| Feature                                             | Status    | Notes                       |
| --------------------------------------------------- | --------- | --------------------------- |
| Profile: name, about, photo                         | done      | F12                         |
| Username, username link and QR                      | partial   | shown; change it in Signal  |
| Appearance (page theme)                             | done      | F11                         |
| Chat colors and wallpapers                          | missing   |                             |
| Chats, notifications, privacy, data usage           | done      | F11                         |
| Blocked list, block and unblock here               | done      | F12, F38                    |
| Import contacts (and their photos) from the phone   | done      | F36                         |
| Stories on/off                                      | done      | F12                         |
| Notification profiles                               | missing   |                             |
| Language                                            | missing   | the page is English         |
| Linked devices, backups, change number, delete data | different | stay in Signal on the phone |
| Allow sealed sender from anyone (8.37)              | different | only when Desktop is the primary device; Six is linked |
| Window, tray, zoom, spell check, launch at login    | different | no screen on Six            |

## Everywhere

| Feature                                                | Status  | Notes                     |
| ------------------------------------------------------ | ------- | ------------------------- |
| Notifications with Signal's content and sound settings | done    | F11                       |
| Keyboard shortcuts (Signal's list)                     | partial | formatting, Escape, Enter |
| Reconnects by itself                                   | done    |                           |
| Release notes / what's new                             | done    | F45                       |

## Backchannel Android

Mike (2026-11-04): where the page can match Backchannel for Android, it
should. Checked against Android's change list of 2026-11-04 (bc1 to bc9).

| Android feature                                   | Status    | Notes                                                  |
| ------------------------------------------------- | --------- | ------------------------------------------------------ |
| Sticker replies, bold italic, forward a poll      | done      | F28, F8, F6                                            |
| Reply privately, viewer stays in one message      | done      | F23, F30                                               |
| @mentions in forwards, forward to any number      | done      | F32, F4                                                |
| Markdown shortcuts, styled copy and paste         | done      | F33                                                    |
| Full markdown, list helpers, pasted markdown      | done      | F42                                                    |
| Hanging indent in bubbles                         | done      | F42                                                    |
| Typed emoticons become emoji                      | done      | F43: Android's list and timing                         |
| Double-tap (here double-click) to react           | done      | F43                                                    |
| Starred messages                                  | done      | F43: kept by the helper                                |
| One skin tone for every emoji                     | done      | F11                                                    |
| Your own photo for anyone                         | done      | F44: kept by the helper                                |
| What's New after an update                        | done      | F45: all entries since the start, new ones marked      |
| Immich picker                                     | done      | F48: the helper calls Immich; the key stays on the server |
| Reply to one photo of an album                    | done      | F47, F53, F54: with photos, GIFs, files, stickers      |
| Remind me about a message                         | done      | F49: kept by the helper                                |
| Keyword alerts in muted chats                     | done      | F50: on the page only                                  |
| On-device translate                               | done      | F51: browser's own Translator API (Chrome)             |
| On-device voice-note transcription                | skipped   | Mike 2026-11-06: no (would need a model on Six)        |
| Lock a chat                                       | different | the page is behind its own token; no fingerprint here  |
| Link someone to a phone contact                   | different | F46: phone links sync over; on the web, nickname + own photo |
| v14: blur media until tapped, everywhere or per chat | done   | F55: kept by the helper                                |
| v14: delete just the attachment, keep the text    | done      | F55: synced to linked devices                          |
| v14: search inside All media                      | done      | F55                                                    |
| v14: hide or delete contacts                      | done      | F55: Signal's Remove; Delete chat was already there    |
| v14: hide group system messages                   | different | the page never shows them (only real messages cross the bridge) |
| v14: voice note transcript                        | skipped   | Mike 2026-11-06: no transcription on the web           |
| v14: mute or auto-delete voice notes              | missing   |                                                        |
| v14: auto-save to gallery, keep EXIF, batched notifications, sticker favorite, Android Auto, connection dot | different | phone-only or Signal does it (EXIF is stripped by Signal's own send) |
| Notifications, screenshots, passphrase, push, icon, Photo apps, Open links | different | phone-only |
