# Notifications

home-hosted pushes supervision events to any number of **destinations**. A destination is a Telegram
chat or a webhook — the same list, because both are just somewhere an alert lands, and you may have
several of either.

Two settings groups, and the split is the point:

- **General** — which events fire, and the throttle. Set **once**.
- **Destinations** — where they go. Each one has an on/off switch and an **Own settings** toggle:
  off (the default for a new one) means it follows the general block entirely; on means it carries
  its own toggles and throttle.

So "tell me about crashes and host thresholds, throttled every two minutes, to my phone and the
group chat" is configured once and pointed at two places. A send never blocks supervision: a failure
is logged and recorded against that destination alone, and the others still go out.

## Setup

1. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token it prints.
2. In the panel: **Workspace Settings → Notifications → Destinations**, press **Add Telegram**.
3. Paste the token into that destination's box and press **Save token**, then **Detect chats**.
4. Send your bot a message from the chat you want the alerts in — a bot cannot open a conversation —
   then pick that chat from the list (or paste its id).
5. Press **Send a test**: the chat gets a message, and the panel shows the result and its timestamp.
6. Leave **Own settings** off to follow the general block, or turn it on to give this chat its own.

A second chat is another **Add Telegram** — it gets its own bot token, stored under its own id.

<details>
<summary><b>Doing it without the UI</b></summary>

```bash
TOKEN='123456:ABC...'
WS='?workspace=default'   # every notifications route is workspace-scoped; omit for the default one

curl -X PUT "http://127.0.0.1:3999/api/notifications/destinations/alerts/token$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

# which chats can this bot see (after you message it once)?
curl -X POST "http://127.0.0.1:3999/api/notifications/destinations/alerts/detect-chats$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

curl -X POST "http://127.0.0.1:3999/api/notifications/destinations/alerts/test$WS" \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d '{"chatId":"123456789"}'
```

Every Telegram route names a destination id (`alerts` here), and the token is stored under it — which
is what lets one workspace point at several chats. `detect-chats` accepts a token override, so one
can be tried before it is saved; `DELETE /api/notifications/destinations/alerts/token` removes it.

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

Two destinations cannot share an `id`: it keys a destination's throttle, its last-result record **and
a Telegram destination's bot token**, so a duplicate would make two behave as one. The save is
refused and names the id, and so is a webhook whose URL is missing or not http(s) — an enabled
destination that can never send.

**Send a test** on a destination tries the values *in the form*, so an unsaved URL and header block
are what gets exercised.

## Where the token lives

The workspace's `.hh/<workspace>/.secrets.json`, mode `0600`, next to that workspace's DDNS
credentials, as a map from **destination id** to bot token. The password and API-token hashes are panel-wide and live in
`.hh/.control-secrets.json`. The token is never written into `servers.config.json`, so committing or
sharing a config cannot leak it — and `GET /api/settings/workspace` reports `tokenSet: true|false`,
never the token itself.

## Delivery failures

Sends are fire-and-forget: supervision never waits on a chat or webhook API. A failure is logged, and
the last outcome is recorded per destination and shown on its row, so a wrong chat id or an
unreachable URL is visible there instead of silently swallowing alerts.

## Throttling

`cooldownMs` (default two minutes) is per **destination, server and reason**, so a flapping process
cannot flood any one destination — and one destination inside its window never silences another. It
lives in the general block, or on a destination that has **Own settings** on.
