#!/usr/bin/env bash
#
# A blank-host backup/restore demo, with a real database.
#
# Two hosts, one after the other, in throwaway directories:
#
#   1. host A — a panel with one entry (a MongoDB container) and some data in it
#   2. take a backup: `home-hosted backup create --all --exclude global:secrets`
#      (plans first, then `--confirm` applies)
#   3. host B — a *blank* home, nothing configured
#   4. restore into it: `home-hosted backup restore <name> --all --confirm`
#   5. start the entry on host B and read the database back
#
# Every step is a real command against a real panel and a real container. Nothing is faked, and the
# script fails loudly rather than continuing on a wrong assumption.
#
# Usage: docs/demo/blank-host-restore.sh
# Requires: docker, pnpm, node 24. Runs entirely under $TMPDIR; touches nothing of yours.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hh-demo-XXXXXX")"
HOST_A="$WORK/host-a"
HOST_B="$WORK/host-b"
DATA="$WORK/blog"
MONGO="hh-demo-mongo"
APP="hh-demo-blog"
PANEL_A=6470
PANEL_B=6471
CLI=(pnpm --dir "$REPO" exec tsx src/cli.ts)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

cleanup() {
  docker rm -f "$APP" "$MONGO" >/dev/null 2>&1 || true
  HHOSTED_HOME="$HOST_A" "${CLI[@]}" down >/dev/null 2>&1 || true
  HHOSTED_HOME="$HOST_B" "${CLI[@]}" down >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------- host A

say "Host A: a blank machine with one stack"

mkdir -p "$HOST_A"
HHOSTED_HOME="$HOST_A" "${CLI[@]}" up --port "$PANEL_A" --no-autostart >/dev/null
TOKEN_A="$(HHOSTED_HOME="$HOST_A" "${CLI[@]}" set-token --generate | grep -oE 'hh_[A-Za-z0-9_-]+' | head -1)"
note "panel on :$PANEL_A"

# The entry owns the container, and the hooks reach it by name. That is the shape a real setup has,
# and it is what makes the dump possible: `mongodump` is run by the entry's own `dump` hook.
curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d "{
    \"id\": \"blog-db\",
    \"command\": \"docker\",
    \"args\": [\"run\", \"--rm\", \"--name\", \"$APP\", \"-p\", \"27017:27017\", \"mongo:7\"],
    \"port\": 27017,
    \"autostart\": true,
    \"dump\": {
      \"command\": \"sh\",
      \"args\": [\"-c\", \"docker exec $APP mongodump --db blog --archive=/tmp/blog.archive --quiet && docker cp $APP:/tmp/blog.archive {dumpDir}/blog.archive\"]
    },
    \"load\": {
      \"command\": \"sh\",
      \"args\": [\"-c\", \"docker cp {dumpDir}/blog.archive $APP:/tmp/blog.archive && docker exec $APP mongorestore --archive=/tmp/blog.archive --drop --quiet\"]
    }
  }" \
  "http://127.0.0.1:$PANEL_A/api/servers?workspace=default"
note "declared the entry, with dump/load hooks so the database backs itself up"

# The dump hook dumps inside the container, then copies the archive out to {dumpDir} — one command,
# because a hook is one program. A database running on the host itself writes to {dumpDir} directly
# and needs no copy.
note "dump: mongodump in the container, copied out to the panel's dump directory"

curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $TOKEN_A" \
  "http://127.0.0.1:$PANEL_A/api/servers/blog-db/start?workspace=default"
note "started blog-db"

for _ in $(seq 1 60); do
  docker exec "$APP" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done

docker exec "$APP" mongosh --quiet --eval '
  db.getSiblingDB("blog").posts.insertMany([
    { title: "How I stopped using tmux", slug: "tmux" },
    { title: "One panel for six services", slug: "panel" },
    { title: "Backups that survive a dead disk", slug: "backups" },
  ])
' >/dev/null
note "seeded 3 documents into blog.posts"

# ---------------------------------------------------------------------------- the backup

say "Taking a backup"

# The plan first: what the archive would capture, written nothing.
HHOSTED_HOME="$HOST_A" "${CLI[@]}" backup create --all --exclude global:secrets
HHOSTED_HOME="$HOST_A" "${CLI[@]}" backup create --all --exclude global:secrets --confirm
ARCHIVE="$(HHOSTED_HOME="$HOST_A" "${CLI[@]}" backup list --json | node -e '
  let raw = ""
  process.stdin.on("data", chunk => raw += chunk)
  process.stdin.on("end", () => {
    const view = JSON.parse(raw)
    process.stdout.write(view.files[0].name)
  })
')"
note "archive: $ARCHIVE"

# Host A is gone, which is the premise of the whole exercise. Its container has to go with it, or
# the port is still held when host B tries to start the restored entry. The entry owns $APP now, so
# that is the one to remove — $MONGO only ever existed to seed it.
HHOSTED_HOME="$HOST_A" "${CLI[@]}" down >/dev/null 2>&1 || true
docker rm -f "$APP" "$MONGO" >/dev/null 2>&1 || true
note "stopped host A's container (host A is gone, after all)"

say "What is in the archive"
node -e '
  const { execFileSync } = require("node:child_process")
  const out = execFileSync("unzip", ["-Z1", process.argv[1]], { encoding: "utf8" })
  for (const line of out.trim().split("\n")) console.log("  " + line)
' "$HOST_A/.hh/.backups/$ARCHIVE" 2>/dev/null || note "(unzip not installed; skipping the listing)"

# ---------------------------------------------------------------------------- host B

say "Host B: a blank machine, nothing configured"

mkdir -p "$HOST_B"
if [ -e "$HOST_B/.hh/workspaces.json" ]; then
  note "unexpected: host B is not blank"; exit 1
fi
note "$HOST_B has no .hh at all"

HHOSTED_HOME="$HOST_B" "${CLI[@]}" up --port "$PANEL_B" --no-autostart >/dev/null
# A token to authorise the upload. The archive carries host A's `secrets.json`, so this one is
# replaced by the restore and a fresh one is minted afterwards.
SETUP_TOKEN="$(HHOSTED_HOME="$HOST_B" "${CLI[@]}" set-token --generate | grep -oE 'hh_[A-Za-z0-9_-]+' | head -1)"
note "panel on :$PANEL_B"

# The archive travels as a file, which is the whole point: one artifact to move.
cp "$HOST_A/.hh/.backups/$ARCHIVE" "$WORK/$ARCHIVE"

# The plan first, always: a restore writes over live data, so the default is to say what it would do.
say "Planning the restore (nothing is written yet)"
mkdir -p "$HOST_B/.hh/.backups"
cp "$HOST_A/.hh/.backups/$ARCHIVE" "$HOST_B/.hh/.backups/$ARCHIVE"
HHOSTED_HOME="$HOST_B" "${CLI[@]}" backup restore "$ARCHIVE" --all
rm -f "$HOST_B/.hh/.backups/$ARCHIVE"
curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bearer $SETUP_TOKEN" \
  -F "file=@$WORK/$ARCHIVE" \
  "http://127.0.0.1:$PANEL_B/api/backups/restore?confirm=true"
note "uploaded and restored onto the blank host"

# `--exclude global:secrets` is why host B keeps its own password and token: the archive never
# carried them. Without it the restore would have replaced host B's credentials with host A's, and
# anyone holding that old token would still have access — so this demo takes the safe route and the
# docs recommend it. Host B's token is untouched, and stays the one minted above.
TOKEN_B="$SETUP_TOKEN"
note "host B keeps its own credentials: the archive excluded global:secrets"

say "What host B now has"
HHOSTED_HOME="$HOST_B" "${CLI[@]}" status

# ---------------------------------------------------------------------------- prove it serves

say "Starting the restored entry"

START_ANSWER="$(curl -sS -X POST -H "Authorization: Bearer $TOKEN_B" \
  "http://127.0.0.1:$PANEL_B/api/servers/blog-db/start?workspace=default")"
node -e 'const a = JSON.parse(process.argv[1]); if (a.ok !== true) { console.error("  start refused: " + (a.message ?? a.error ?? JSON.stringify(a))); process.exit(1) }' "$START_ANSWER"

for _ in $(seq 1 60); do
  docker exec "$APP" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done

say "Reading the database on the restored host"

# Nothing was applied by hand. The restore staged the dump, and the entry's own `load` hook ran
# `mongorestore` when the entry started — that is the feature this demo exists to show.
for _ in $(seq 1 30); do
  COUNT="$(docker exec "$APP" mongosh --quiet --eval 'db.getSiblingDB("blog").posts.countDocuments()' 2>/dev/null || echo 0)"
  [ "$COUNT" = "3" ] && break
  sleep 1
done
TITLES="$(docker exec "$APP" mongosh --quiet --eval 'db.getSiblingDB("blog").posts.find({}, {title:1, _id:0}).toArray().map(p => p.title).join(" | ")')"

say "Result"
note "blog.posts documents: $COUNT"
note "titles: $TITLES"
note "applied by the entry's load hook, not by this script"

if [ "$COUNT" = "3" ]; then
  printf '\n\033[32mrestored: the same 3 documents, on a host that started blank\033[0m\n'
else
  printf '\n\033[31mFAILED: expected 3 documents, got %s\033[0m\n' "$COUNT"
  exit 1
fi
