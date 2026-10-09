#!/bin/bash
# Fork-only: run from a clone of mikesimone/Signal-Desktop; never part of the upstream PR.
# Rebuilds external-client-bridge from fork main as 3 commits on upstream base.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE=${BASE:-5c1a030485ea64a1c311288cd6b5eecbe36964cd}
# Mike's call (2026-10-09 12:20 PT): upstream commits are authored by him (the CLA
# signer) with no Claude trailers. Fork main keeps the trailers.
TRAILER=''
export GIT_AUTHOR_NAME='Mike Simone' GIT_AUTHOR_EMAIL='mike@mikesimone.net'
export GIT_COMMITTER_NAME='Mike Simone' GIT_COMMITTER_EMAIL='mike@mikesimone.net'
git checkout -q -B external-client-bridge "$BASE"
git checkout main -- packages/windows-local-pipe .oxlint/rules/enforceFileSuffix.mjs .oxlintrc.json .prettierignore knip.js package.json pnpm-lock.yaml pnpm-workspace.yaml rolldown.config.ts
git commit -q -m "Add windows-local-pipe: a user-only, local-only named pipe server

Node's net.Server creates Windows named pipes with a default DACL that
lets other local accounts connect and does not reject remote (SMB)
clients. This small N-API addon creates the pipe with a DACL granting
only the current user, PIPE_REJECT_REMOTE_CLIENTS and
FILE_FLAG_FIRST_PIPE_INSTANCE (so another process cannot squat the
name), and exposes connections as Node Duplex streams.

Used by the external client bridge in the next commit.
$TRAILER"
# app/startup_config.main.ts: fork-only dev AUMID change.
git diff --name-only "$BASE" main | grep -v -e '^docs/' -e '^\.github/' -e '^packages/windows-local-pipe/' -e '^app/startup_config.main.ts$' | xargs git checkout main --
git commit -q -m "Add an opt-in local API for companion apps

Lets an app on the same computer, approved by the user, read chats and
messages, receive live updates, send text messages, mark messages read
and take over message notifications, so Signal can stay minimized while
the user works in that app.

- Off by default. Runs only when the desktop.externalClients remote-config
  flag and the user's setting (Settings > Privacy > \"Apps on this
  computer\") are both on.
- Local only: a Unix socket in the user's data or runtime directory on
  macOS and Linux, a user-only named pipe on Windows.
- Each app has an Ed25519 key and is approved once in a Signal dialog
  that lists what it asks for. Grants are stored in the encrypted
  database and can be removed in Settings.
- Main owns the transport, sessions and approval; the main window's
  renderer answers through existing models and send paths. Sends refuse
  with a reason wherever the composer would block or ask the user
  (untrusted identity, message request, blocked, etc.) instead of
  prompting.
- Public DTOs never include phone numbers, service ids, keys or file
  paths; deleted, erased and view-once content is withheld.
$TRAILER"
git checkout main -- docs/external-client-architecture.md docs/external-client-decisions.md docs/external-client-threat-model.md docs/external-client-probe.node.mjs
python3 - <<'EOF'
p='docs/external-client-architecture.md'
s=open(p).read()
old="""- `docs/external-client-implementation-plan.md` (file-by-file plan and the 15
  first-task questions)
"""
assert old in s
s=s.replace(old,"- `docs/external-client-probe.node.mjs` (a dependency-free reference client)\n")
open(p,'w').write(s)
EOF
git add docs
git commit -q -m "docs: external client architecture, threat model and reference client
$TRAILER"
test -z "$(git diff main -- . ':!docs' ':!.github' ':!app/startup_config.main.ts')" && echo "code identical to main"
git log --oneline -4
git checkout -q main
