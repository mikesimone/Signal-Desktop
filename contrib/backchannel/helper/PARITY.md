# Parity with Signal Desktop

Standing rule (Mike, 2026-10-13): the Backchannel page does everything Signal
Desktop does, and keeps up as Signal adds features. This is the list. Each
built item has a decision (Fn) in
[docs/external-client-decisions.md](../../../docs/external-client-decisions.md).

Status: **done**, **partial**, **missing**, or **different** (on purpose).
A weekly check compares new Signal releases against this list and adds
what they bring.

Last reviewed: 2026-10-19, against Signal 8.34.0-alpha.1 in fork main.

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
| Link previews (view)                                     | done      |                                                      |
| Mark read as you read, clears "mark as unread"           | done      | F13                                                  |
| Unread line, jump-to-newest button with count            | done      | F18                                                  |
| Typing indicators (see them)                             | done      | F14                                                  |
| Disappearing messages (expire on time)                   | done      |                                                      |
| View-once media                                          | missing   |                                                      |
| Contact cards (view)                                     | missing   |                                                      |
| Payments, gift badges                                    | missing   |                                                      |
| Message details (per-recipient delivery)                 | missing   |                                                      |
| Edit history                                             | missing   |                                                      |
| Chat header: details, members, safety number             | partial   | F16: details and members; safety number missing      |
| Contact card from a group member's photo or name         | done      | F23: About and Message                               |
| Reply privately to a group message                       | different | F23: beyond Signal; links both ways on this page     |
| Per-chat settings: timer, mute, block, colors, nickname  | partial   | F15: timer, mute, block; colors and nickname missing |
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
| Send contact cards                                 | missing   |                                              |
| GIF search                                         | missing   |                                              |
| Typing indicators (send them)                      | done      | F14                                          |
| Safety number changed: Send anyway                 | done      | F35                                          |
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
| Blocked list                                        | done      | F12 (unblock from the chat) |
| Stories on/off                                      | done      | F12                         |
| Notification profiles                               | missing   |                             |
| Language                                            | missing   | the page is English         |
| Linked devices, backups, change number, delete data | different | stay in Signal on the phone |
| Window, tray, zoom, spell check, launch at login    | different | no screen on Six            |

## Everywhere

| Feature                                                | Status  | Notes                     |
| ------------------------------------------------------ | ------- | ------------------------- |
| Notifications with Signal's content and sound settings | done    | F11                       |
| Keyboard shortcuts (Signal's list)                     | partial | formatting, Escape, Enter |
| Reconnects by itself                                   | done    |                           |
| Release notes / what's new                             | missing |                           |
