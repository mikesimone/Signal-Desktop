#!/usr/bin/env bash
# Copyright 2026 Mike Simone
# SPDX-License-Identifier: AGPL-3.0-only

# Hourly upstream sync for the headless Signal Desktop on Six
# (sigdesktop.mikesimone.net). Run by sigdesktop-sync.timer as msimone, from
# an installed copy (/usr/local/bin/sigdesktop-sync), never from the working
# tree, because the run itself merges into that tree.
#
# This script only collects what changed since the last run:
#   - new commits on signalapp/Signal-Desktop main (Signal merges internally
#     and closes its GitHub PRs unmerged, so commits are the real signal),
#   - new upstream release tags,
#   - PRs merged into either repository,
# and hands that list to one `claude -p` run in the fork clone. Claude does
# the merge, adapts contrib/signal-headless, rebuilds, verifies, pushes and
# writes the report that goes to Mike's Slack DM. Nothing watches this run.
#
# State: ~/.local/state/sigdesktop-sync (last upstream SHA, known tags, last
# run time, one log per Claude run). The first run only records a baseline.
set -euo pipefail

REPO=/home/msimone/Signal-Desktop
UPSTREAM=signalapp/Signal-Desktop
FORK=mikesimone/Signal-Desktop
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/sigdesktop-sync"
CLAUDE="$HOME/.local/bin/claude"
NOTIFY=/home/msimone/noc-in-a-box/slack-notify.sh
SIGNAL_API_URL=http://127.0.0.1:8080
SIGNAL_NUMBER=+17028798487

log() { echo "$(date -u +%FT%TZ) [sigdesktop-sync] $*"; }

# Slack first, Signal note-to-self only if Slack fails (Mike, 2026-10-02).
notify() {
  "$NOTIFY" six "$1" && return 0
  curl -fsS -X POST "$SIGNAL_API_URL/v2/send" -H 'Content-Type: application/json' \
    -d "{\"message\":$(printf '%s' "$1" | jq -Rs .),\"number\":\"$SIGNAL_NUMBER\",\"account\":\"$SIGNAL_NUMBER\",\"noteToSelf\":true}" \
    >/dev/null || log "WARNING: could not notify"
}

# The chat page URL carries the access token; never let it reach a report.
redact() { sed -E 's#(sigdesktop\.mikesimone\.net|127\.0\.0\.1:8083|localhost:8083)/[A-Za-z0-9_-]{8,}#\1/<token>#g'; }

mkdir -p "$STATE/runs"
exec 9>"$STATE/lock"
flock -n 9 || { log "previous run still going, skipping"; exit 0; }

cd "$REPO"
git remote get-url upstream >/dev/null 2>&1 \
  || git remote add upstream "https://github.com/$UPSTREAM"
git remote set-url --push upstream DISABLED
git fetch -q upstream main
git fetch -q origin main

head_sha=$(git rev-parse upstream/main)
now=$(date -u +%FT%TZ)
tags_now=$(git ls-remote --tags --refs upstream 'refs/tags/v*' | sed 's#.*refs/tags/##' | sort -V)

if [[ ! -f "$STATE/upstream-sha" ]]; then
  echo "$head_sha" >"$STATE/upstream-sha"
  echo "$tags_now" >"$STATE/tags"
  echo "$now" >"$STATE/last-run"
  log "baseline recorded at upstream $head_sha, nothing sent"
  exit 0
fi

last_sha=$(cat "$STATE/upstream-sha")
last_run=$(cat "$STATE/last-run")
new_commits=$(git log --no-merges --format='%h %ad %s' --date=short "$last_sha..upstream/main" 2>/dev/null || true)
pending=$(git rev-list --count origin/main..upstream/main)
new_tags=$(comm -13 <(sort "$STATE/tags") <(echo "$tags_now" | sort) | sort -V)
merged_prs=$(for r in "$UPSTREAM" "$FORK"; do
  gh pr list -R "$r" --state merged --search "merged:>=$last_run" \
    --json number,title,url,mergedAt \
    --jq ".[] | \"$r#\(.number) merged \(.mergedAt): \(.title) \(.url)\""
done)

echo "$now" >"$STATE/last-run"
if [[ -z "$new_commits$new_tags$merged_prs" ]]; then
  log "nothing new since $last_run (fork is $pending commits behind upstream)"
  exit 0
fi
# Record before running, so a failing merge is tried again only when
# upstream moves, not every hour.
echo "$head_sha" >"$STATE/upstream-sha"
echo "$tags_now" >"$STATE/tags"

changes=$(cat <<EOF
Upstream $UPSTREAM main moved ${last_sha:0:9} -> ${head_sha:0:9} since $last_run.
origin/main is $pending commits behind upstream/main.

New upstream commits:
${new_commits:-(none)}

New upstream release tags:
${new_tags:-(none)}

PRs merged since the last run:
${merged_prs:-(none)}
EOF
)

prompt=$(cat <<'EOF'
You are the unattended hourly sync for the headless Signal Desktop on Six
(sigdesktop.mikesimone.net). You are in /home/msimone/Signal-Desktop, a clone
of mikesimone/Signal-Desktop (main), with upstream = signalapp/Signal-Desktop
(fetched, push disabled). Nobody is watching: work it through on your own and
end with the report. The changes since the last run are listed at the end.

Read contrib/signal-headless/README.md and Dockerfile first.

1. Merge upstream/main into main (git merge, never rebase, never force-push,
   never reset). Keep the fork's external client bridge and everything under
   contrib/. If conflicts need judgement you can't make confidently, run
   git merge --abort, change nothing else, and report FAILED.
2. Look at what the merge changed that affects the headless build: the
   Node/pnpm versions in package.json, native dependencies, build scripts,
   electron-builder config, and the files contrib/signal-headless/patches/
   apply to. Update contrib/signal-headless (Dockerfile, patches,
   entrypoint.sh) to match, and commit with a message saying why.
3. Keep the running container until the new image is proven:
   docker tag signal-headless:latest signal-headless:previous
   then, in contrib/signal-headless, docker compose build (it can take up to
   an hour; run it in the foreground with a long timeout). If the build
   fails, fix it if the cause is clear and retry; otherwise leave the old
   container running, do not push, and report FAILED with the last error
   lines.
4. docker compose up -d, then check, within about 10 minutes:
   - docker compose logs shows "loaded N conversations" and "bridge: ready"
     after the restart;
   - with the token from `docker compose exec signal-desktop screen.sh url`,
     curl https://sigdesktop.mikesimone.net/<token>/api/state returns 200,
     and https://sigdesktop.mikesimone.net/api/state returns 404.
   If Signal or the bridge doesn't come up, roll back:
   docker tag signal-headless:previous signal-headless:latest &&
   docker compose up -d --no-build, confirm the old one is healthy again,
   do not push, and report FAILED.
   If the bridge reports keyMismatch or awaitingApproval, don't delete or
   approve anything: report it, Mike handles pairing.
5. Only when healthy: git push origin main. Then
   docker image prune -f to free the old layers (disk on / is tight).

Rules: don't touch the signal-forwarder stack, signal-cli-api, nginx,
certbot, DNS or anything outside this repository and its container. Don't
add --no-sandbox-style flags beyond what the Dockerfile already has. Never
print the access token or the full chat URL anywhere, including the report.

Your final message is the report sent to Mike's Slack DM. Start it with
"OK:", "FAILED:" or "NEEDS MIKE:", then at most 8 short lines: the upstream
range and version merged, what you changed in contrib/signal-headless and
why, build and health results, and the pushed commit.
EOF
)

run_log="$STATE/runs/$(date -u +%Y%m%dT%H%M%SZ).log"
log "sending to Claude ($(echo "$new_commits" | grep -c . || true) new commits), log $run_log"
set +e
BASH_DEFAULT_TIMEOUT_MS=600000 BASH_MAX_TIMEOUT_MS=3600000 \
"$CLAUDE" -p "$prompt

## Changes since the last run
$changes" \
  --permission-mode default \
  --allowedTools Read Edit Write Glob Grep \
    'Bash(git:*)' 'Bash(docker compose:*)' 'Bash(docker tag signal-headless:*)' \
    'Bash(docker image prune:*)' 'Bash(docker images:*)' 'Bash(curl:*)' \
    'Bash(tail:*)' 'Bash(head:*)' 'Bash(grep:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
    'Bash(df:*)' 'Bash(sleep:*)' 'Bash(diff:*)' 'Bash(jq:*)' \
  --disallowedTools 'Bash(git push --force:*)' 'Bash(git push -f:*)' \
    'Bash(git push --force-with-lease:*)' 'Bash(git reset:*)' 'Bash(git rebase:*)' \
    'Bash(git clean:*)' 'Bash(git remote:*)' \
  </dev/null >"$run_log" 2>&1
rc=$?
set -e

report=$(redact <"$run_log" | tail -c 3000)
if [[ $rc -ne 0 || -z "$report" ]]; then
  report="FAILED: claude -p exited $rc. Log on Six: $run_log
$report"
fi
notify "sigdesktop sync
$report"
log "done (claude exit $rc)"
