import type { WebhookTarget } from '#src/shared/contracts'
import process from 'node:process'
import { expandEnv } from '#src/helpers/env-file'
import { errorMessage } from '#src/shared/error-message'

export interface WebhookOutcome {
  ok: boolean
  error?: string
}

/**
 * The general outbound transport: one HTTP request per configured target.
 *
 * `format` and `headers` are what make this able to talk to services with different contracts,
 * rather than a per-service adapter — the difference between ntfy and a JSON receiver is
 * exactly those two fields:
 *
 * - a **JSON** receiver (Discord, Slack, a bespoke endpoint) gets the event as a JSON body,
 *   with the fields those services read (`text`, `content`) filled in;
 * - **ntfy** takes the plain message as the body and reads the notification's own fields from
 *   headers, so a target pointing at `ntfy.sh/<topic>` sets `format: text` and
 *   `headers: Title: …`, which is a configuration rather than a branch here.
 *
 * Headers are per target, so a bearer token or an API key lives in the config, not in code.
 * `${ENV}` expands in the URL and the header values, the way it does everywhere else in the
 * config — which is how a token stays **out** of `settings.json`: write `Authorization:
 * Bearer ${HH_WEBHOOK_TOKEN}` and the value comes from the panel's environment.
 */

export interface NotificationEventBody {
  title: string
  message: string
  reason: string
  serverId: string
  label: string
}

export interface WebhookPayload {
  text: string
  content: string
  title: string
  message: string
  reason: string
  server: string | null
  label: string | null
  at: number
}

/** The JSON body for one event. Exported so a test can pin the shape without a round trip. */
export function webhookPayload(event: NotificationEventBody, now = Date.now()): WebhookPayload {
  const text = `${event.title}\n${event.message}`
  return {
    text,
    // Slack reads `text`; Discord reads `content`. One body serves both.
    content: text,
    title: event.title,
    message: event.message,
    reason: event.reason,
    server: event.serverId.length > 0 ? event.serverId : null,
    label: event.label.length > 0 ? event.label : null,
    at: now,
  }
}

/**
 * `Name: value` lines into a header map.
 *
 * The format is line-based rather than a JSON object because it is edited in a textarea, and
 * a value with a colon in it (`Authorization: Bearer a:b`) must survive: only the **first**
 * colon separates the two.
 *
 * `vars` expands `${ENV}` in the values, so a credential does not have to be written into the
 * config file. A name the panel's environment does not define is left as written, the same rule
 * `expandEnv` follows everywhere else — and `unexpanded` names those, because a leftover `${…}`
 * is not a credential.
 */
export function parseHeaders(
  text: string,
  vars: Record<string, string | undefined> = process.env,
): { headers: Record<string, string>, errors: string[], unexpanded: string[] } {
  const headers: Record<string, string> = {}
  const errors: string[] = []
  const unexpanded: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#'))
      continue
    const at = trimmed.indexOf(':')
    if (at <= 0) {
      errors.push(`"${trimmed}" is not a "Name: value" header`)
      continue
    }
    const name = trimmed.slice(0, at).trim()
    const value = expandEnv(trimmed.slice(at + 1).trim(), vars)
    if (value.includes('${'))
      unexpanded.push(name)
    headers[name] = value
  }
  return { headers, errors, unexpanded }
}

/** Why a target cannot be sent to, or null when it can. Also used to validate a save. */
export function targetProblem(target: Pick<WebhookTarget, 'url' | 'headers'>, options: { requireUrl?: boolean } = {}): string | null {
  const url = target.url.trim()
  if (url.length === 0)
    return options.requireUrl === false ? null : 'no URL configured'

  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return 'the URL is not valid'
  }
  // Refused rather than attempted: a file: or javascript: target is not a receiver, and the
  // error a failed fetch gives for one does not say why.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return `the URL must be http or https, not ${parsed.protocol}`

  // A leftover `${NAME}` in a *header* is reported for the same reason the URL one is: the send
  // either succeeds with a literal `${NAME}` as the credential (a 401 the row blames on the
  // receiver) or 200s because the receiver ignored a header it could not use. The URL's check was
  // the only one, so an unset variable in `Authorization` failed silently.
  const { errors, unexpanded } = parseHeaders(target.headers)
  const problems = [...errors, ...(unexpanded.length > 0
    ? [`the ${unexpanded.map(name => `"${name}"`).join(', ')} header still holds an unexpanded placeholder — an environment variable in it is not set`]
    : [])]
  return problems.length > 0 ? problems.join('; ') : null
}

export async function sendWebhook(
  target: Pick<WebhookTarget, 'url' | 'method' | 'format' | 'headers'>,
  event: NotificationEventBody,
  fetchImpl?: typeof fetch,
): Promise<WebhookOutcome> {
  const problem = targetProblem(target)
  if (problem !== null)
    return { ok: false, error: problem }

  const { headers, errors } = parseHeaders(target.headers)
  if (errors.length > 0)
    return { ok: false, error: errors.join('; ') }

  const payload = webhookPayload(event)
  const asText = target.format === 'text'
  const body = asText ? payload.message : JSON.stringify(payload)

  // Expanded here and validated above, so an unset `${ENV}` in the URL is reported as such
  // rather than surfacing as a generic "fetch failed".
  const url = expandEnv(target.url.trim(), process.env)
  if (url.includes('${'))
    return { ok: false, error: `the URL still holds an unexpanded placeholder: ${url}` }

  try {
    const response = await (fetchImpl ?? fetch)(url, {
      method: target.method,
      headers: {
        // A receiver that cares about the type must not be sent `text/plain` for JSON, and a
        // target's own header wins: `Headers` in the config is the last word.
        'content-type': asText ? 'text/plain; charset=utf-8' : 'application/json',
        ...headers,
      },
      body,
      // A wedged receiver must not hold a supervisor tick for ever.
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const trimmed = detail.trim().slice(0, 200)
      return { ok: false, error: `answered ${response.status}${trimmed.length > 0 ? `: ${trimmed}` : ''}` }
    }
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
