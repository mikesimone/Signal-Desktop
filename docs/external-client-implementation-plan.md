<!-- Copyright 2026 Signal Messenger, LLC -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# External Client Bridge: Implementation Plan

Baseline: `5c1a030485ea64a1c311288cd6b5eecbe36964cd`.

## 1. Did the analysis change the design?

Yes, in one structural way and three smaller ones. None of them stop
Milestone A.

1. **The service cannot live in main.** The project brief pictures a single
   `ExternalClientService` inside "Signal Desktop". In the current source all
   messaging logic runs in the main window renderer (preload world). The
   design splits: transport, session, authorization in main; a thin service
   adapter in the renderer behind one closed, typed IPC channel pair.
   Milestone A is entirely main-side, so it is unaffected.
2. **No headless send exists.** A small new renderer function is required to
   send text with the composer's safety checks but without composer state or
   modal dialogs (architecture §4.3).
3. **No "conversation visible" signal exists** for notifications, and
   mark-read is gated on Signal's window being active. Both need explicit
   policy (decisions D9, D10).
4. **No "database locked" state exists.** Status values become `starting`,
   `ready`, `unlinked`, `unavailable` (key error, corruption). `upgrading` is
   folded into `starting`.

## 2. Answers to the 15 first-task questions

**1. Where should the external-client service live?**
Split. `ts/externalClient/` holds protocol, framing, endpoint and session code
(`.std.ts` / `.node.ts`, testable under Node). `ts/main/externalClientMain.main.ts`
wires it into main. `ts/externalClient/service/*.preload.ts` holds the
renderer adapter, registered from `ts/windows/main/phase1-ipc.preload.ts`
(the existing home of main-initiated renderer handlers).

**2. Which existing Signal APIs can service its requests?**
`ConversationController.getAll/get` + `ConversationModel.format()` for
conversations; `DataReader.getOlderMessagesByConversation` /
`getNewerMessagesByConversation` / `getMessageById` (via `MessageCache`) for
messages; `ConversationModel.enqueueMessageForSend` (with new precondition
wrapper) for send; `ConversationModel.markRead` → `markConversationRead` for
read; `throttledBumpTyping` for typing; `decryptAttachmentV2ToSink` in main for
attachment bytes; `sql.sqlRead/sqlWrite('getItemById'/'createOrUpdateItem')`
in main for grants. Full table: architecture §4.3.

**3. Which operations are currently coupled to the renderer?**
All conversation, message, send, read, typing, receive, notification and
calling operations. Pre-send checks are additionally coupled to React render
conditions and to Redux composer state. Mark-read is coupled to Signal's
window activity.

**4. What would need refactoring to make them renderer-independent?**
Full renderer independence would mean moving `textsecure`, the models and the
job queues into main or a utility process: a re-architecture Signal would not
accept for this feature, and not needed. The bridge instead treats the
renderer as the service host. The minimal refactors are:

- Extract `getComposerBlockReason(conversation)` from
  `CompositionArea.dom.tsx` gating into a `.std.ts` helper used by both the
  composer and the bridge (prevents drift).
- Add `sendTextFromExternalClient` next to `maybeForwardMessages`
  (`ts/util/`), using `enqueueMessageForSend(..., { dontClearDraft: true })`.
- Add an observer hook (a small `EventEmitter` or callback list) on
  `ConversationController` and `MessageCache` that the bridge's event module
  subscribes to, instead of patching Redux.

**5. What transport is most appropriate on Windows?**
A named pipe created by Node's `net` module in main:
`\\.\pipe\signal-desktop-external-client-<hash>`. No TCP. The DACL must be
confirmed or tightened before anything beyond the handshake is served
(threat model T3).

**6. What transport abstraction should support Linux/macOS later?**
The same `net.Server` path API with a Unix domain socket in a `0700`
directory (`$XDG_RUNTIME_DIR/signal-desktop/` on Linux, `<userData>/external-client/`
on macOS and as Linux fallback). `ExternalClientTransport` is an interface
(`listen`, `close`, `onConnection(Duplex)`); the platform difference is only
endpoint computation and pre-bind checks (`endpoint.node.ts`). A future
companion browser bridge is an ordinary client, not a transport.

**7. Where should authorization state live?**
In SQLCipher, in the `items` table under `externalClientGrants`, read and
written only by main through `sql.sqlRead/sqlWrite`. Classified "remove after
unlink". The on/off switch lives beside it (`externalClientsEnabled`). Not in
`ephemeral.json` / `config.json`: those are plaintext and writable by any
same-user process, so a grant there would be forgeable (threat model T12).

**8. How should Signal present first-use authorization?**
A modal, sandboxed, context-isolated child window of the main window, built
like the existing permissions popup (`showPermissionsPopupWindow`,
`app/main.main.ts:1625`): client display name (marked as self-reported), key
fingerprint, requested capabilities as checkboxes with plain-language labels,
Allow / Deny. If the main window is hidden, it is shown first. One
outstanding prompt per key; repeated denials impose a cool-down.

**9. How should revocation work?**
A Settings section lists grants (name, fingerprint, capabilities, approved
at, last seen) with a Revoke button. Revoke → renderer calls
`external-client:revoke(fingerprint)` → main deletes the grant and closes
every live session for that key. Disabling the feature closes the listener
and all sessions but keeps grants. Unlink deletes grants.

**10. How can events be emitted without exposing Redux/internal IPC?**
A renderer module subscribes to semantic choke points
(`ConversationController` add/update/remove, `#doAddSingleMessage`,
`MessageCache` updates, `cleanupMessageFromMemory`), maps to DTOs, and sends
`external-client:event { type, conversationId, dto }` to main only while at
least one session is subscribed. Main fans out to sessions that hold the
relevant capability, with per-session sequence numbers and bounded queues.

**11. How should attachments be streamed safely?**
Opaque ids (HMAC of the `message_attachments` PK under a per-run server
secret, so ids are unguessable and not stable across restarts unless we
choose otherwise). The renderer validates the id maps to a message the session
may read and returns the row to main. Main decrypts with
`decryptAttachmentV2ToSink` and streams binary frames (`0x02`) of ≤ 64 KiB
with `drain`-based backpressure and a per-session concurrent-stream limit. No
paths or keys leave main.

**12. What Signal internals must remain inaccessible?**
Threat model §6. In short: DB/keys/config, filesystem paths, libsignal and
protocol objects, network layer, raw IPC, Redux, model instances, linking,
backups, calling.

**13. What is the smallest patch that proves the concept?**
Milestone A–E with 11 files touched, roughly: protocol + framing + endpoint +
session (≈ 600 lines, all Node-testable), main wiring (≈ 120 lines), grant
store + prompt (≈ 300 lines), renderer adapter with three methods
(`conversations.list`, `messages.list`, `messages.sendText`) plus
`messageAdded` events (≈ 300 lines), tests. Settings UI and revocation UI can
follow; for the proof, enablement is the DB item and a dev-only environment
variable in unpackaged builds.

**14. Which parts are likely to be controversial upstream?**

- The feature itself: Signal has historically declined third-party client
  interfaces, citing security and support burden. This is the dominant risk.
- Any new listening endpoint on users' machines, however local.
- Sending and marking read on behalf of a UI Signal does not control
  (bypassing the active-window gate and the safety-number modal).
- The Windows pipe DACL story if it needs native code.
- Ongoing API stability commitment for a protocol third parties depend on.
- Notification semantics.

**15. Can further reduction in Signal-side scope improve upstream odds?**
Yes:

- **Read-only first.** A v1 with `conversations.read`, `messages.read` and
  events, and no send, removes the hardest review questions (T17, T18).
- **No renderer adapter for reads.** Not recommended (duplicates logic).
- **Move discovery, launch, and the browser bridge entirely outside Signal**
  (already the plan).
- **No settings page**; a single toggle in Privacy and a list under it.
- **Ship behind a remote-config flag** (`desktop.externalClients`) so Signal
  can disable it centrally, mirroring how Signal gates other features.
- **Upstream only the seam**: if Signal will not accept the bridge, a smaller
  upstreamable piece is the internal refactors from Q4 (composer block reason,
  model observers), which make a maintained out-of-tree patch much cheaper.

## 3. Commit sequence (upstream-shaped)

| #   | Commit                                                            | Files                                                                                                     | Milestone |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| 1   | docs: external-client architecture, threat model, plan, decisions | `docs/external-client-*.md`                                                                               | 0         |
| 2   | external-client: protocol constants, schemas, errors              | `ts/externalClient/protocol.std.ts`                                                                       | A         |
| 3   | external-client: length-prefixed framing                          | `ts/externalClient/framing.std.ts`                                                                        | A         |
| 4   | external-client: platform endpoint (pipe/UDS)                     | `ts/externalClient/endpoint.node.ts`                                                                      | A         |
| 5   | external-client: server and session handshake                     | `ts/externalClient/ExternalClientServer.node.ts`, `ExternalClientSession.node.ts`                         | A         |
| 6   | external-client: main-process wiring, disabled by default         | `ts/main/externalClientMain.main.ts`, `app/main.main.ts`, `ts/types/StorageKeys.std.ts`                   | A         |
| 7   | tests: framing, protocol, server handshake                        | `ts/test-node/externalClient/*`                                                                           | A         |
| 8   | external-client: client keys and grant store                      | `ts/externalClient/grants.node.ts`, `ts/main/externalClientMain.main.ts`                                  | B         |
| 9   | external-client: approval window                                  | `app/main.main.ts` (window), `external_client_approval.html`, `ts/windows/externalClientApproval/*`       | B         |
| 10  | external-client: renderer service channel                         | `ts/externalClient/service/ExternalClientService.preload.ts`, `ts/windows/main/phase1-ipc.preload.ts`     | B         |
| 11  | external-client: conversation read API + DTOs                     | `ts/externalClient/dto.std.ts`, service                                                                   | B         |
| 12  | external-client: message read API with paging                     | service                                                                                                   | C         |
| 13  | external-client: events                                           | `ts/externalClient/service/events.preload.ts`, observer hooks in `ConversationController`, `MessageCache` | D         |
| 14  | refactor: extract composer block reason                           | `ts/util/getComposerBlockReason.std.ts`, `CompositionArea.dom.tsx`                                        | E         |
| 15  | external-client: send text                                        | `ts/util/sendTextFromExternalClient.preload.ts`, service                                                  | E         |
| 16  | external-client: mark read                                        | service                                                                                                   | E         |
| 17  | external-client: settings toggle and grants list                  | `Preferences.dom.tsx`, `smart/Preferences.preload.tsx`, `_locales/en/messages.json`                       | E         |
| 18  | tests: integration and security matrix                            | `ts/test-node/externalClient/*`, `ts/test-mock/externalClient/*`                                          | E         |

## 4. File-by-file

### New files

- `ts/externalClient/protocol.std.ts`: protocol name, versions, capability
  list, error codes, limits, zod schemas for envelopes and handshake, TS
  types. No Electron, no Node.
- `ts/externalClient/framing.std.ts`: `encodeFrame`, `FrameDecoder` with hard
  max; pure `Uint8Array` code.
- `ts/externalClient/endpoint.node.ts`: `getExternalClientEndpoint({
platform, userDataPath, runtimeDir, username })`, `prepareEndpoint()` with
  directory/socket checks, `cleanupEndpoint()`.
- `ts/externalClient/ExternalClientServer.node.ts`: `net.Server` lifecycle,
  connection cap. Takes an injected `getSignalVersion()` and logger so it
  never imports Electron.
- `ts/externalClient/ExternalClientSession.node.ts`: per-connection state
  machine (awaiting hello, greeted, closed), handshake, timeouts, error
  mapping, write-side backpressure guard.
- `ts/externalClient/errors.std.ts`: `FrameError`.
- `ts/main/externalClientMain.main.ts`: reads enablement from SQL after
  `sqlInitPromise`, starts/stops the server, supplies hello info, stops on
  quit.
- `ts/externalClient/auth.node.ts` (M-B): Ed25519 transcripts, verify, server
  key generation and signing, key fingerprint. `node:crypto` only.
- `ts/externalClient/ExternalClientAuthority.node.ts` (M-B): grant store over
  injected storage, approval serialization, denial cool-down, revocation.
- `ts/externalClient/hostTypes.std.ts` (M-B): interfaces the session uses to
  reach the authority and the renderer host.
- `ts/externalClient/conversationDto.std.ts` (M-B): field-by-field mapping
  from `ConversationType` to the public DTO.
- `ts/externalClient/rendererChannel.std.ts` (M-B): the single main↔renderer
  IPC pair and its zod schemas.
- `ts/externalClient/service/ExternalClientService.preload.ts` (M-B, C):
  renderer adapter answering `conversations.*` and `messages.*`.
- `ts/externalClient/messageDto.std.ts` (M-C): field-by-field message DTO
  mapper with the redaction rules.
- `ts/externalClient/hooks.std.ts` (M-D): import-free hook functions that
  Signal's message code calls; no-ops until a client subscribes.
- `ts/externalClient/eventQueue.std.ts` (M-D): per-object coalescing queue.
- `ts/externalClient/conversationDiff.std.ts` (M-D): turns successive
  conversation lookups into public update/remove events.
- `ts/externalClient/service/ExternalClientEvents.preload.ts` (M-D):
  renderer event source; queues, converts and batches events to main.
- `ts/test-helpers/externalClientFakeClient.node.ts`: fake client for tests.
- `packages/windows-local-pipe/` (Windows hardening): N-API named pipe
  server with a user-only DACL, `PIPE_REJECT_REMOTE_CLIENTS` and
  first-instance ownership; connections are `Duplex` streams. Registered like
  `windows-ucv` (root `package.json`, `pnpm-workspace.yaml` `allowBuilds`,
  `rolldown.config.ts` externals, oxlint/knip/prettier config).
- `docs/external-client-probe.node.mjs`: dependency-free reference client
  for manual testing (`--request`, `--messages n`, `--watch`).
- `.github/workflows/external-client.yml`: the external-client tests on
  Linux, macOS and Windows (free hosted runners on the public fork).
- Later: Preferences UI,
  `docs/external-client-protocol.md`, `docs/external-client-rambox.md`.
- Tests under `ts/test-node/externalClient/` (named `*_test.std.ts` /
  `*_test.node.ts` per Signal's suffix rules).

### Modified files

- `app/main.main.ts`: construct `ExternalClientMain` after SQL init; stop it in
  the existing quit path. About ten lines.
- `ts/types/StorageKeys.std.ts`: add `externalClientsEnabled: boolean` (and
  later `externalClientGrants`) to `StorageAccessType` and to
  `STORAGE_KEYS_TO_REMOVE_AFTER_UNLINK`.
- `ts/windows/main/phase1-ipc.preload.ts` (M-B): installs the renderer
  service.
- `ts/ConversationController.preload.ts` (M-B): `isInitialFetchComplete()`.
- `_locales/en/messages.json` (M-B, D): approval prompt strings.
- `ts/models/conversations.preload.ts`, `ts/services/MessageCache.preload.ts`,
  `ts/util/cleanup.preload.ts` (M-D): one hook call each (message added,
  updated, removed).
- Later: `CompositionArea.dom.tsx`, Preferences files.

## 5. Milestone A scope

- Off unless `items.externalClientsEnabled === true`, or, in unpackaged
  builds only, `SIGNAL_ENABLE_EXTERNAL_CLIENTS=1`.
- Listener starts only after SQL initialized successfully.
- Methods: `session.hello`, `session.disconnect`. `hello` returns protocol
  name, negotiated version, Signal version, capability vocabulary, session id,
  feature flags (`calling.available: false`, `authentication.required: true`).
  Any other method returns `UNSUPPORTED_METHOD` after hello; before hello,
  anything but `hello` gets `INVALID_REQUEST` and the connection is closed.
- No renderer changes, no UI, no grants yet.

### Milestone A status (2026-10-08)

Implemented (fork `main`, commit `417a28f`) as commit 2 of the series
(protocol, framing, endpoint, server, session, main wiring, storage key,
tests). The commit table above lists them as separate commits for
upstreaming; they are squashed into one Milestone A commit for now.

Verified in a Linux container with Node 24.21.0:

- 35 unit/integration tests pass (`mocha` + `tsx` on
  `ts/test-node/externalClient/`), including a real Unix socket server and a
  fake client: handshake, pre-hello silence, version mismatch, malformed and
  oversized frames, invalid UTF-8, unknown and internal-IPC method names,
  second hello, disconnect, handshake timeout, connection cap,
  `0700`/`0600` permissions, socket cleanup and restart, refusal to replace a
  non-socket file.
- `oxlint` clean on all touched files; `prettier` applied.
- `tsc --noEmit` reports no errors in touched files; the 115 errors it reports
  are identical before and after the change (all from the unbuilt
  `@signalapp/types` workspace package in this environment).

Not verified: running inside Electron (`pnpm start`), and anything on Windows
(named pipe DACL, `FILE_FLAG_FIRST_PIPE_INSTANCE`). Signal's native prebuilds
could not be downloaded in the build container.

## 5b. Milestone B scope and status (2026-10-08)

Scope: client approval and conversation metadata reads.

- `session.hello` requires a 32-byte `clientNonce` and returns a `challenge`
  plus `server { publicKey, signature }`, the server's Ed25519 signature over
  the session id, challenge and client nonce. Capabilities in hello are the
  ones the server implements (`conversations.read` only for now).
- `session.authenticate { publicKey, signature }` succeeds only for a key with
  a stored grant. Unknown key: `NOT_AUTHORIZED` and close.
- `authorization.request { publicKey, signature, displayName, capabilities }`
  shows a native modal dialog (`dialog.showMessageBox`, Deny is default and
  cancel) on the main window with the client name, key fingerprint and
  capabilities. Approve stores or merges a grant and authorizes the session.
  One prompt at a time (`busy`), 60 s cool-down per key after a deny.
- `conversations.list { limit?, cursor? }` (default 100, max 500, offset
  cursor) and `conversations.get { conversationId }`, both behind
  `conversations.read`, answered by the renderer through one IPC pair. Only
  the main window's `webContents` may answer. `NOT_READY` until the initial
  conversation fetch completes, while unlinked, or on a 15 s renderer timeout.
- Grants, the server key and enablement live in SQLCipher `items` and are
  removed on unlink. Revocation closes live sessions for the key (no UI yet).

Verified in a Linux container: 66 tests pass (handshake incl. server
signature, authenticate with and without grant, wrong-key and replayed
signatures, approval allow/deny/narrowing/busy/cool-down, permission checks per
method, param validation, renderer error mapping, DTO mapping, authority
storage). `oxlint` clean; no new `tsc` errors against the baseline.

Not verified: Electron runtime (`pnpm start`; native prebuilds blocked), the
dialog's appearance, and the renderer adapter against a real account. Windows
pipe checks are tracked under T3/T4 in the threat model.

## 5c. Milestone C scope and status (2026-10-08)

Scope: read message history, behind `messages.read`.

- `messages.list { conversationId, limit?, cursor? }`: newest page first
  (default 50, max 100), each page oldest-first. `nextCursor` is the id of the
  oldest row read; pass it back as `cursor` to page further back. Uses the
  same `DataReader.getOlderMessagesByConversation` call as the timeline;
  messages held in `MessageCache` win over database rows. A cursor from
  another conversation is `INVALID_ARGUMENT`.
- `messages.get { messageId }`: one message, `NOT_FOUND` unless its
  conversation is one `conversations.list` would show.
- `MessageDTO` (`ts/externalClient/messageDto.std.ts`): id, conversation,
  direction, kind (`text`, `sticker`, `viewOnce`, `deleted`, `unsupported`),
  author conversation id, sent/received times, body (+ `bodyTruncated` for
  long messages), mentions as conversation ids, attachment metadata (no ids,
  paths or keys), quote (author, timestamp, text), edited flag, `expiresAt`,
  read flag for incoming.
- Only incoming/outgoing rows are returned; notifications, group updates
  and call history are skipped. Expired disappearing messages are skipped.
  Deleted, erased and view-once messages return no body, mentions,
  attachments or quote; a quote of a view-once message has no text.
- Reads never mark anything read and never write to the database (unlike
  the timeline's `cleanAttributes`, which can migrate rows).
- Not in C: reactions, formatting ranges, link previews, poll/payment/contact
  details, attachment download (needs `attachments.read`, T14), events (D).

Verified in a Linux container: 77 tests pass, including DTO redaction rules,
expiry, mention and quote mapping, `messages.read` enforcement, param
validation and forwarding. `oxlint` clean; no new `tsc` errors.

Verified inside Electron on Windows 11 (Anton, 2026-10-08, production
servers, separate linked profile): approval dialog shown and accepted;
`conversations.list` paged 280 conversations; `messages.list` returned
oldest-first pages with non-overlapping cursor paging, attachments, quotes and
`expiresAt` populated; `messages.get` and `NOT_FOUND` behaved as specified.
Not yet run: reconnecting with the stored grant (`session.authenticate`)
inside Electron.

## 5d. Milestone D scope and status (2026-10-08)

Scope: live updates, so clients stop polling.

- `events.subscribe { topics }` with topics `conversations` (needs
  `conversations.read`) and `messages` (needs `messages.read`); all or
  nothing, `PERMISSION_DENIED` if any topic is not granted. Returns every
  topic the session now holds. `events.unsubscribe { topics? }` removes some
  or all.
- Events are frames with no `id`: `{ event, seq, data }`. `seq` starts at 1
  per session and grows by one per event. Events:
  `conversation.updated` (ConversationDTO, also when a conversation becomes
  listed), `conversation.removed { conversationId }` (deleted or no longer
  listed), `message.added` / `message.updated` (MessageDTO),
  `message.removed { messageId, conversationId }`, and `events.dropped {}`.
- Client contract: subscribe, then snapshot with the list methods, then apply
  events as idempotent upserts and removals. After `events.dropped` the
  session holds no topics: subscribe again and resnapshot.
- `events.dropped` is sent when a client has more than 1 MiB unread
  (`maxEventBacklogBytes`), when the renderer's queue overflows (5000
  pending objects), and when the renderer reloads.
- Sources: message added/updated/removed come from one hook each in
  `ConversationModel.#doAddSingleMessage` (received and sent),
  `MessageCache.#updateRedux` and
  `cleanupMessageFromMemory`. Conversation changes come from diffing Redux's
  `conversationLookup` (by reference, then by DTO) at most every 250 ms.
  Events are coalesced per object and sent to main in batches of up to 200
  every 100 ms; DTOs are built at send time and only for listed
  conversations.
- With no subscriber main tells the renderer no topics, the hooks are
  no-ops and Redux is not observed.
- Known limits: updates to messages not held in `MessageCache` are not seen
  (architecture §2.9); a mute that expires on its own produces no event
  until something else changes the conversation; group story replies and
  stories are not sent, matching `messages.list`.
- The approval dialog now labels `messages.read` ("Read your messages,
  including new ones as they arrive").

Verified in a Linux container: 97 tests pass, including subscribe
authorization and capability checks, per-session topic routing, `seq`
order, unsubscribe, topic union tracking, drop-and-resubscribe, a stalled
reader being dropped, queue coalescing and the conversation diff. The probe's
`--watch` mode was run against a test server. Not yet run inside Electron.

## 6. Build and test notes

- **Running a dev build against production (do this, not NODE_ENV).** Leave
  `NODE_ENV` unset and put a git-ignored `config/local-development.json` next
  to the other configs: a copy of `production.json` with
  `"updatesEnabled": false` and `"storagePath"` set to a separate profile
  directory (CONTRIBUTING.md, "Changing to production"). Then
  `SIGNAL_ENABLE_EXTERNAL_CLIENTS=1 pnpm start`, and check the `userData:`
  line before linking.
- **Never set `NODE_ENV=production` on an unpackaged build.** Signal treats
  it as a packaged release (`app/config.main.ts:38`), clears `NODE_CONFIG`,
  and opens the real `%APPDATA%\Signal` profile. On 2026-10-08 only the
  single-instance lock held by the installed Signal stopped it.

- Upstream requires Node 24.21.0 and pnpm; native prebuilds are fetched from
  `build-artifacts.signal.org` during `pnpm install`.
- Unit tests for `ts/externalClient` do not import Electron and can run under
  plain mocha with `tsx`; the full `pnpm test-node` uses `electron-mocha`.
