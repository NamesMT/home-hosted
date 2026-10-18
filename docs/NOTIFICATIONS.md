# Notifications

home-hosted pushes supervision events to a Telegram chat and to any number of **webhooks**. The bot
token stays in the secrets file; a webhook carries its credential in a header, so `${ENV}` expansion
is the way to keep that one out of the config file too (see [Webhooks](#webhooks)).

Each transport keeps its own event toggles and its own throttle, so crashes can go to one chat while
only host warnings go to a phone. A send never blocks supervision: a failure is logged and recorded
against that transport alone, and the others still go out.

## Setup

1. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token it prints.
2. In the panel: **Workspace Settings → Notifications**, paste the token, press **Detect chats**.
3. Send your bot a message from the chat you want the alerts in — a bot cannot open a conversation —
   then pick that chat from the list (or paste its id).
4. Press **Test**: the chat gets a message, and the panel shows the result and its timestamp.
5. Turn on **Enabled**, then choose which events you want.

<details>
<summary><b>Doing it without the UI</b></summary>

```bash
TOKEN='123456:ABC...'
WS='?workspace=default'   # every notifications route is workspace-scoped; omit for the default one

curl -X PUT "http://127.0.0.1:3999/api/notifications/token$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

# which chats can this bot see (after you message it once)?
curl -X POST "http://127.0.0.1:3999/api/notifications/detect-chats$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

curl -X POST "http://127.0.0.1:3999/api/notifications/test$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d '{"chatId":"123456789"}'
```

`detect-chats` and `test` accept an override, so a token can be tried before it is saved.
`DELETE /api/notifications/token` removes it. Each workspace keeps its own token and target; the
panel-wide host alerts use every workspace's own settings.

</details>

## What it sends

| event | toggle | default |
| --- | --- | --- |
| a server gave up restarting | `onCrash` | ✅ |
| a server exceeded its memory limit | `onCrash` | ✅ |
| a health check is failing | `onUnhealthy` | ✅ |
| a server was force-restarted (health timeout) | `onForcedRestart` | ✅ |
| a server recovered | `onRecovered` | ⬜ |
| host thresholds breached, and recovered | `onHost` | ✅ |
| a dynamic DNS record changed, or a pass failed | `onDdns` | ✅ |

Host thresholds themselves — disk, memory, swap, load, temperature — are **Global settings → Host
vitals**. Dynamic DNS carries one message per pass that changed a record, and one per failed pass —
see [DDNS.md](./DDNS.md).

## Webhooks

A webhook is a URL, a method, a body format and a set of headers — a **list**, so one panel can alert
several places. It is what covers everything other than Telegram, because those services differ only
in the shape of the request:

| | URL | Body | Headers |
| --- | --- | --- | --- |
| **ntfy** | `https://ntfy.sh/<topic>` | `plain text` | `Title: home-hosted` (ntfy reads the title here), `Priority: default`, and `Authorization: Bearer <token>` when the topic needs one |
| **Discord** | your webhook URL | `JSON` | none — the payload fills `content` |
| **Slack** | your webhook URL | `JSON` | none — the payload fills `text` |
| **anything else** | your URL | either | whatever it needs |

The JSON body carries the same event under several names (`text`, `content`, `title`, `message`,
`reason`, `server`, `label`, `at`), so a receiver reads whichever it knows. `format: text` sends the
message alone, which is what ntfy's publish API expects — pointed at ntfy with `format: json` it
would show the JSON itself as the notification.

Headers are `Name: value` per line, with the split on the **first** colon so a token containing one
survives. `${ENV}` expands in the URL and in the values, the same rule the rest of the config follows
— so a token stays out of `settings.json` entirely:

```json
{ "headers": "Authorization: Bearer ${HH_WEBHOOK_TOKEN}" }
```

A literal token in a header works too, but it then lives in the workspace's `settings.json` — a plain
config file. Prefer the placeholder above, and treat that file as sensitive if you do use one.

Two targets cannot share an `id`: it keys that target's own throttle and last-result record, so a
duplicate would make two targets behave as one. The save is refused and names the id, and so is a
target whose URL is missing or not http(s) — an enabled target that can never send.

**Send a test** on a target tries the values *in the form*, so an unsaved URL and header block are
what gets exercised.

## Where the token lives

The workspace's `.hh/<workspace>/.secrets.json`, mode `0600`, next to that workspace's DDNS
credentials. The password and API-token hashes are panel-wide and live in
`.hh/.control-secrets.json`. The token is never written into `servers.config.json`, so committing or
sharing a config cannot leak it — and `GET /api/settings/workspace` reports `tokenSet: true|false`,
never the token itself.

## Delivery failures

Sends are fire-and-forget: supervision never waits on a chat or webhook API. A failure is logged, and
the last outcome is recorded per transport and shown in **Workspace Settings → Notifications**, so a
wrong chat id or an unreachable URL is visible there instead of silently swallowing alerts.

## Throttling

`cooldownMs` (default two minutes) is per **transport, server and reason**, so a flapping process
cannot flood any one destination — and one destination inside its window never silences another.
