#!/usr/bin/env bash
#
# A blank-host backup/restore demo, with a real database.
#
# Two hosts, one after the other, in throwaway directories:
#
#   1. host A — a panel with one entry (a MongoDB container) and some data in it
#   2. take a backup: `home-hosted backup create` (it plans first, then `--confirm` applies)
#   3. host B — a *blank* home, nothing configured
#   4. restore into it: `home-hosted backup restore <name> --confirm`
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

mkdir -p "$DATA/dump"
docker run -d --name "$MONGO" -p 27017:27017 mongo:7 >/dev/null
note "started $MONGO"

# Wait for it to accept connections, rather than sleeping and hoping.
for _ in $(seq 1 60); do
  docker exec "$MONGO" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done

docker exec "$MONGO" mongosh --quiet --eval '
  db.getSiblingDB("blog").posts.insertMany([
    { title: "How I stopped using tmux", slug: "tmux" },
    { title: "One panel for six services", slug: "panel" },
    { title: "Backups that survive a dead disk", slug: "backups" },
  ])
' >/dev/null
note "seeded 3 documents into blog.posts"

# The dump, not the live files. A running database's data directory copied file by file can be torn,
# which the README warns about; `mongodump --archive` is the consistent artifact.
docker exec "$MONGO" mongodump --db blog --archive=/tmp/blog.archive --quiet
docker cp "$MONGO:/tmp/blog.archive" "$DATA/dump/blog.archive" >/dev/null
note "dumped the database to $DATA/dump/blog.archive"

mkdir -p "$HOST_A"
HHOSTED_HOME="$HOST_A" "${CLI[@]}" up --port "$PANEL_A" --no-autostart >/dev/null
TOKEN_A="$(HHOSTED_HOME="$HOST_A" "${CLI[@]}" set-token --generate | grep -oE 'hh_[A-Za-z0-9_-]+' | head -1)"
note "panel on :$PANEL_A"

# An entry whose `backupPaths` names the dump, and whose port lets the panel health-check it.
curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d "{
    \"id\": \"blog-db\",
    \"command\": \"docker\",
    \"args\": [\"run\", \"--rm\", \"--name\", \"$APP\", \"-p\", \"27017:27017\", \"mongo:7\"],
    \"port\": 27017,
    \"backupPaths\": [\"$DATA/dump\"]
  }" \
  "http://127.0.0.1:$PANEL_A/api/servers?workspace=default"
note "declared the entry: docker run mongo:7, backupPaths = $DATA/dump"

# ---------------------------------------------------------------------------- the backup

say "Taking a backup"

# The plan first: what the archive would capture, written nothing.
HHOSTED_HOME="$HOST_A" "${CLI[@]}" backup create
HHOSTED_HOME="$HOST_A" "${CLI[@]}" backup create --confirm
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
# the port is still held when host B tries to start the restored entry.
docker rm -f "$MONGO" >/dev/null 2>&1 || true
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
cp "$WORK/$ARCHIVE" "$HOST_B/.hh/.backups/$ARCHIVE"
HHOSTED_HOME="$HOST_B" "${CLI[@]}" backup restore "$ARCHIVE"
rm -f "$HOST_B/.hh/.backups/$ARCHIVE"
curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bearer $SETUP_TOKEN" \
  -F "file=@$WORK/$ARCHIVE" \
  "http://127.0.0.1:$PANEL_B/api/backups/restore?confirm=true"
note "uploaded and restored onto the blank host"

# The archive carried host A's `global/secrets.json`, so host B now has host A's password hash and
# API token hash — the archive is the whole machine's identity, not just its entries. The README
# warns about exactly this. A real move should either accept that or rotate afterwards; this demo
# rotates, because a token that travelled in an archive is a token in a file.
TOKEN_B="$(HHOSTED_HOME="$HOST_B" "${CLI[@]}" set-token --generate | grep -oE 'hh_[A-Za-z0-9_-]+' | head -1)"
note "rotated host B's API token (the archive had brought host A's)"

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

docker cp "$DATA/dump/blog.archive" "$APP:/tmp/blog.archive"
BEFORE="$(docker exec "$APP" mongosh --quiet --eval 'db.getSiblingDB("blog").posts.countDocuments()')"
note "documents in blog.posts before applying the dump: $BEFORE — the container is fresh, so it is empty"

# The dump is the data; restoring the *panel* brought back the entry and the dump beside it. Applying
# the dump is the database's own step, and this is it.
docker exec "$APP" mongorestore --archive=/tmp/blog.archive --quiet --drop
COUNT="$(docker exec "$APP" mongosh --quiet --eval 'db.getSiblingDB("blog").posts.countDocuments()')"
TITLES="$(docker exec "$APP" mongosh --quiet --eval 'db.getSiblingDB("blog").posts.find({}, {title:1, _id:0}).toArray().map(p => p.title).join(" | ")')"

say "Result"
note "blog.posts documents: $COUNT"
note "titles: $TITLES"

if [ "$COUNT" = "3" ]; then
  printf '\n\033[32mrestored: the same 3 documents, on a host that started blank\033[0m\n'
else
  printf '\n\033[31mFAILED: expected 3 documents, got %s\033[0m\n' "$COUNT"
  exit 1
fi
