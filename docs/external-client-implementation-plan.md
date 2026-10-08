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
- `ts/externalClient/service/ExternalClientService.preload.ts` (M-B): renderer
  adapter answering `conversations.list` / `conversations.get`.
- `ts/test-helpers/externalClientFakeClient.node.ts`: fake client for tests.
- Later: `MessageCache` adapter, Preferences UI,
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
- `_locales/en/messages.json` (M-B): approval prompt strings.
- Later: `MessageCache`, `CompositionArea.dom.tsx`, Preferences files.

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

## 6. Build and test notes

- Upstream requires Node 24.21.0 and pnpm; native prebuilds are fetched from
  `build-artifacts.signal.org` during `pnpm install`.
- Unit tests for `ts/externalClient` do not import Electron and can run under
  plain mocha with `tsx`; the full `pnpm test-node` uses `electron-mocha`.
