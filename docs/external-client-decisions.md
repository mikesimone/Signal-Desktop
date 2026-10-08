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

## D10. No notification changes in v1

DECISION: v1 leaves Signal's notification logic alone and documents that
clients should not raise their own Signal notifications by default.

WHY: Signal has no per-conversation visibility signal; a `presence.set` design
needs upstream agreement.

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
