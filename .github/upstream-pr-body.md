### First time contributor checklist:

- [x] I have read the [README](https://github.com/signalapp/Signal-Desktop/blob/main/README.md) and [Contributor Guidelines](https://github.com/signalapp/Signal-Desktop/blob/main/CONTRIBUTING.md)
- [x] I have signed the [Contributor Licence Agreement](https://signal.org/cla/)

### Contributor checklist:

- [x] My contribution is **not** related to translations.
- [x] My commits are in nice logical chunks with [good commit messages](http://chris.beams.io/posts/git-commit/)
- [x] My changes are [rebased](https://medium.com/free-code-camp/git-rebase-and-the-golden-rule-explained-70715eccc372) on the latest [`main`](https://github.com/signalapp/Signal-Desktop/tree/main) branch
- [x] A `pnpm run ready` run passes successfully ([more about tests here](https://github.com/signalapp/Signal-Desktop/blob/main/CONTRIBUTING.md#tests))
- [x] My changes are ready to be shipped to users

### Description

Discussion: https://community.signalusers.org/t/opt-in-local-only-api-for-companion-apps-implementation-ready/76679

Adds an opt-in, local-only API so an app on the same computer, approved by the user, can read chats and messages, get live updates, send text messages, mark messages read and take over message notifications. The goal is that people who keep their messengers in one window (Rambox, Ferdium, Franz and similar) can use Signal there while Signal Desktop stays minimized in the tray, without anyone scraping the UI or shipping unofficial clients.

**Off by default, two gates.** Nothing listens unless both the `desktop.externalClients.beta` / `.prod` remote-config flag and the user's setting (Settings > Privacy > "Apps on this computer") are on. Signal can turn it off centrally.

**Local only.** A Unix socket in the user's data or runtime directory on macOS and Linux (mode 0600). On Windows a named pipe created by a small N-API addon (`packages/windows-local-pipe`) with a user-only DACL, `PIPE_REJECT_REMOTE_CLIENTS` and `FILE_FLAG_FIRST_PIPE_INSTANCE`, because Node's own pipes allow other local accounts and remote SMB clients.

**User approval per app.** Each app has an Ed25519 key, signs a challenge, and is approved once in a Signal dialog that lists exactly what it asks for. Signal signs back, so the app can pin it. Grants live in the encrypted database and can be removed in Settings, which disconnects the app.

**Capabilities:** `conversations.read`, `messages.read`, `messages.send`, `messages.markRead`, `notifications.manage`. Every method and event topic checks its capability.

**Signal stays authoritative.** Main owns the transport, sessions and approval; the main window's renderer answers through existing models and send paths (`enqueueMessageForSend`, `ConversationModel.markRead`). Sending refuses with a machine-readable reason wherever the composer would block or ask the user (untrusted identity, message request, blocked, left group, announcement-only, etc.); it never makes a trust decision for the user and leaves their draft alone. Notifications are handed off only while the app is subscribed to messages, and return to Signal as soon as it unsubscribes, falls behind or disconnects. Calls always notify in Signal.

**Privacy of the API surface.** DTOs never include phone numbers, service ids, keys or file paths. Deleted, erased and view-once content is withheld, and expired disappearing messages are not returned.

Design, threat model and decisions are in `docs/external-client-architecture.md`, `docs/external-client-threat-model.md` and `docs/external-client-decisions.md`. `docs/external-client-probe.node.mjs` is a dependency-free reference client.

Commits:
1. `packages/windows-local-pipe`, the Windows pipe addon, and its workspace wiring.
2. The bridge, settings UI, strings and tests.
3. Docs and the reference client.

**Test approach**

- 108 new unit tests in `ts/test-node/externalClient/`: framing, protocol schemas, handshake and mutual signatures, approval and revocation, capability checks per method and topic, paging and redaction, events (ordering, coalescing, drop and resubscribe on backpressure), send refusal reasons, notification hand-off and release.
- `pnpm run ready` checks on Windows 11: `test-node` 2520 passing (0 failing), `test-electron` 1523/1523, lint-intl, lint-deps, knip, Prettier and stylelint clean. On Windows `tsc` reports only the missing macOS-only `fs-xattr` types and oxlint only unused-directive errors in files this PR doesn't touch; both are clean for this PR's files on Linux.
- The bridge's unit tests also pass on Linux, macOS and Windows in CI on the fork.
- Manual testing in an unpackaged build on Windows 11, linked as a second device to a phone: approval dialog, listing ~280 conversations, message paging, live incoming and outgoing messages, receipts, edits and deletes, sending to Note to Self, marking a chat read (read sync sent to the other devices), capability enforcement and additive grants, the Windows pipe DACL (only the current user) and refusal of SMB connections.
- Notification hand-off on a clean Windows 11 VM: toasts and "showing a notification" log lines appeared with no client connected, none appeared while a client held notifications (5 incoming messages over 5 minutes), and they came back right after the client disconnected.
- Not verified by hand: macOS (no Mac available; CI only).
