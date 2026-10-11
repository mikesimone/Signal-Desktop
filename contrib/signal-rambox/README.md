# signal-rambox

Use Signal inside [Rambox](https://rambox.app) (or any app that hosts web
pages) through Signal Desktop's local API for companion apps (the external
client bridge, signalapp/Signal-Desktop#8054).

Signal Desktop keeps running, minimized to the tray, and stays the real
client: it holds the keys, sends and receives. This helper is an approved
companion app. It shows your chats with their photos, lets you read and send
text messages, reply with a quote, react with your quick-reaction bar (click a reaction to see who sent
it) and @mention people in groups (type @ and pick from the
members) and
copy text, shows photos, videos, GIFs, voice notes, files and stickers
(with a full-screen viewer, and a Download button for anything Signal has
not fetched yet), marks chats read when you look at them, and while its page is
open, takes over message notifications so you get them from Rambox instead
of Signal. Group chats show each sender's photo, name color and member
label, as Signal does. The page uses Signal's own emoji and Inter fonts.

The chat list has Signal's Pinned and Chats sections in Signal's pin order,
preview lines, the All chats / 1:1 chats / Groups tabs and the unread filter
button. Messages show text formatting, mentions, links and link preview
cards, and can be edited, deleted and forwarded from the message's menu.
Forward lists every chat, most recently used first, and takes as many as
you pick (Signal stops at five). Photos and files are sent by pasting into
the message box, dropping them on the chat, or the paperclip button; the
text becomes their caption. The ⋯ after the quick reactions, and the emoji
button by the message box, open Signal's full emoji picker with search,
categories and Signal's own recently used emoji. Polls show and vote as in
Signal; the poll button by the message box creates one, and "Send to
chats…" or "Send this poll to…" in a poll's menu sends it to as many chats
as you pick, each chat getting its own copy with its own votes (Signal
can't forward a poll). In a narrow window the chat list shows photos only,
as Signal's does.

Not here yet (being added on the fork, aiming at everything Signal Desktop
does): contact cards, typing indicators, voice notes, stories and calls.

Photos, member labels, reactions and replies use fork-only bridge additions
(`conversations.getAvatar`, `messages.react`, `reactions.getPreferred`,
`quoteMessageId` on `messages.sendText`, author details on messages, and
`attachments.getThumbnail`, `attachments.read`, `attachments.download`,
`messages.edit`, `messages.delete`, `attachments.uploadBegin`,
`attachments.uploadChunk`, `messages.forward`, `emoji.getCatalog`, `polls.vote`, `polls.end`,
`polls.send`, `conversations.getMembers`, mentions and
`attachmentUploadIds` on
`messages.sendText`, and pin order, formatting and link previews on the
DTOs),
not part of the upstream proposal. Against a Signal without them the helper
asks only for what Signal offers and the rest of the page still works.

## How it works

```
Rambox  ──http://127.0.0.1:47830/<token>/──▶  signal-rambox  ──pipe──▶  Signal Desktop
(web page)                                    (this helper)          (bridge)
```

Rambox can only show web pages, and a web page cannot open Signal's named
pipe or Unix socket, so this helper sits in between:

- It connects to Signal as an approved app (Ed25519 key, Signal's key pinned
  after the first approval) and asks for only `conversations.read`,
  `messages.read`, `messages.send`, `messages.markRead`, `messages.react`,
  `attachments.read` and `notifications.manage`. Adding a capability makes Signal ask for
  approval once more.
- It serves a chat page on **127.0.0.1 only**. Everything it serves lives
  under a random secret token, so the URL you give Rambox is the only way in.
- Rambox shows the unread badge from the page title (`(3) Signal`), and turns
  the page's notifications into its own. Muted and archived chats don't
  count.

### Why the local web server is safe enough

Any program on the computer, and any web page in any browser, can reach a
port on 127.0.0.1. So every request must:

- start with the secret token (24 random bytes, compared in constant time),
- carry `Host: 127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding),
- if it has an `Origin` or `Sec-Fetch-Site` header, be same-origin,
- for POST, use `Content-Type: application/json`, which a foreign page can
  only send after a CORS preflight that this helper never answers.

The page has a strict Content Security Policy and never inserts text from
Signal as HTML. Photos are decoded inside Signal and handed over as small
re-encoded images; no file path or key leaves Signal. Attachments are read
from Signal in chunks of at most 512 KB and streamed to the page with HTTP
range support (so video can seek). Only images, video and audio are served
inline; every other type is served as a download, so a file from a chat can
never run as a page under the helper's address.

### Fonts

The page loads Signal's fonts from the helper: Inter and the small emoji
font from Signal's `fonts/` folder (next to the helper in the container
image, else the Signal Desktop checkout the helper sits in), and the large
emoji font (every emoji, about 9 MB) from Signal's own downloaded copy in
its profile, or, failing that, downloaded once from Signal's update server,
checked against Signal's digest and kept in the config folder. The token and key live in a folder only your account can
read. Another account on the same computer that learned the token could use
it; on a computer shared with untrusted users, don't run this.

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. In Signal Desktop: Settings > Privacy > **Apps on this computer** > on.
3. Start the helper:

   ```powershell
   node C:\path\to\signal-rambox\signal-rambox.mjs
   ```

   Signal shows an approval dialog for "Rambox (signal-rambox)". Allow it.
   In a terminal the helper prints the URL to use; get it any time with
   `--url`. It never writes the token to a log (a container or service log
   shows only the address without it).

4. In Rambox: **Add app > Add Custom App**, name it Signal, paste the URL,
   and turn on notifications and "Display in tab" for the unread badge.

### Start it at logon (Windows)

```powershell
$node = (Get-Command node).Source
$script = 'C:\path\to\signal-rambox\signal-rambox.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'signal-rambox' -Action $action -Trigger $trigger -Settings $settings
```

Remove it with `Unregister-ScheduledTask signal-rambox -Confirm:$false`.

## Options

```
--user-data <dir>   Signal profile folder (default: the normal one, %APPDATA%\Signal)
--endpoint <path>   connect to this pipe/socket instead of computing it
--port <n>          local port (default 47830)
--bind <address>    listen address (default 127.0.0.1)
--origin <url>      also accept this origin, e.g. an HTTPS name on a reverse
                    proxy in front of the helper (repeatable); --url prints it
--config <dir>      where key.json and token live
                    (default %APPDATA%\signal-rambox, or ~/.config/signal-rambox)
--url               print the Rambox URL and exit
```

For a development build of Signal with its own profile, pass that profile with
`--user-data`. To run Signal and the helper together in Docker on a server,
see [signal-headless](../signal-headless).

## Starting over

- New URL: delete `token` in the config folder and restart; update Rambox.
- Pair again: remove the app in Signal (Settings > Privacy > Apps on this
  computer), delete `key.json`, restart the helper, approve again.
- "Signal's identity key changed": Signal's bridge key is not the one this
  helper pinned (a reinstall or a different profile). Pair again as above if
  you expected that.

## Tests

```
node --test contrib/signal-rambox/test/signal-rambox_test.mjs
```

They run the real helper against a fake Signal bridge (real framing and
signatures), including the request checks above.
