# Notifications

home-hosted can push supervision events to a Telegram chat. It is the only transport today, it is
opt-in, and the bot token never leaves the secrets file.

## Setup

1. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token it prints.
2. In the panel: **Settings → Notifications**, paste the token, press **Detect chats**.
3. Send your bot a message from the chat you want the alerts in — a bot cannot open a conversation —
   then pick that chat from the list (or paste its id).
4. Press **Test**: the chat gets a message, and the panel shows the result and its timestamp.
5. Turn on **Enabled**, then choose which events you want.

<details>
<summary><b>Doing it without the UI</b></summary>

```bash
TOKEN='123456:ABC...'

curl -X POST http://127.0.0.1:3999/api/notifications/token \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

# which chats can this bot see (after you message it once)?
curl -X POST http://127.0.0.1:3999/api/notifications/detect-chats \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d "{\"botToken\":\"$TOKEN\"}"

curl -X POST http://127.0.0.1:3999/api/notifications/test \
  -H 'content-type: application/json' -H "Authorization: Bearer $HH_TOKEN" \
  -d '{"chatId":"123456789"}'
```

`detect-chats` and `test` accept an override, so a token can be tried before it is saved.
`DELETE /api/notifications/token` removes it.

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

Host thresholds themselves — disk, memory, swap, load, temperature — are **Settings → Host**.

## Quiet periods

`cooldownMs` (default two minutes) is per **server and reason**, so a flapping process cannot flood
the chat: it says "down", stays quiet while it flaps, and speaks again once the window passes. `0`
disables the throttle.

## Where the token lives

`$HHOSTED_HOME/.control-secrets.json`, mode `0600`, next to the password and API-token hashes. It is
never written into `servers.config.json`, so committing or sharing a config cannot leak it — and
`GET /api/settings` reports `tokenSet: true|false`, never the token itself.

## Delivery failures

Sends are fire-and-forget: supervision never waits on a chat API. A failure is logged and the last
result is shown in **Settings → Notifications** (`lastResult`, `lastResultAt`), so a wrong chat id is
visible there instead of silently swallowing alerts.
