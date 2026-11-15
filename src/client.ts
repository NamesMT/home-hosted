/**
 * `home-hosted/client` — a typed client for building your own tools on the panel's API.
 *
 * ```ts
 * import { createClient } from 'home-hosted/client'
 *
 * const hh = createClient({ baseUrl: 'http://127.0.0.1:3999', token: process.env.HH_TOKEN })
 * const { servers } = await hh.json(hh.api.servers.$get({ query: {} }))
 * for await (const frame of hh.events({ logs: false }))
 *   console.log(frame.type)
 * ```
 *
 * `api` is Hono's RPC client rooted at `/api`, typed from the panel's own route table, so every path,
 * body and response is checked against the server that answers it; `rpc` is the same client at the
 * root, for `/healthz` and `/openapi`. Types only travel from the server: nothing of it is imported
 * at runtime.
 */
import type { AppType } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { hc } from 'hono/client'
import { isLoopbackHost } from '#src/shared/server-url'

export type { AppType } from '#src/app'
export type {
  ActionResultBody,
  AppState,
  ControlView,
  ServerConfig,
  ServerView,
  SseMessage,
  WorkspaceView,
} from '#src/shared/contracts'

export interface ClientOptions {
  /** Where the panel listens, e.g. `http://127.0.0.1:3999`. */
  baseUrl: string
  /** `<id>:<secret>` from `home-hosted account create`; omit it for a cookie session in a browser. */
  token?: string
  /** A `fetch` to use instead of the global one (tests, proxies, custom TLS). */
  fetch?: typeof fetch
  /**
   * The wait before the `n`-th reconnect attempt, replacing the built-in 250 ms-doubling-30 s
   * backoff. Injected by tests so a retry does not cost a real wait.
   */
  retryDelayMs?: (attempt: number) => Promise<void>
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /**
   * Send `token` over plain `http` to a host that is not this machine. Off by default: the token is
   * full admin, and anyone on the path could read it. Set it only for a network you trust end to end.
   */
  allowInsecureToken?: boolean
}

/** A failed request, carrying the panel's error envelope. */
export class HomeHostedError extends Error {
  override name = 'HomeHostedError'

  constructor(
    message: string,
    /** The HTTP status. */
    readonly status: number,
    /** The stable machine-readable code (`UNKNOWN_SERVER`, `AUTH_REQUIRED`, …). */
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export interface EventsQuery {
  /** Only this workspace's server and log frames. */
  workspace?: string
  /** Only this server's frames (pair it with `workspace`; ids are unique per workspace). */
  serverId?: string
  /** `false` drops log frames. */
  logs?: boolean
  /**
   * Resume after this sequence — the `id:` of the last frame already consumed.
   *
   * The stream answers with one current snapshot first, then the buffered `log` frames published
   * after it, so a reconnecting reader neither misses lines nor re-applies a stale snapshot. The
   * `id` of each frame is on the `id:` line; `readEventStream` exposes it as `lastId`.
   */
  since?: number
  /** Stops the stream. */
  signal?: AbortSignal
  /**
   * Keep the feed alive across a dropped connection.
   *
   * Off by default, because a one-shot reader (`for await … { break }`) must end when it stops
   * reading, not linger retrying a connection it no longer wants. With `reconnect: true` the
   * generator reopens the stream with exponential backoff after the body ends or the request fails,
   * resuming from the last frame `id` it delivered (`?since=`), so a consumer neither loses lines
   * nor re-applies frames it already acted on.
   *
   * It does **not** retry a credential refusal: a restarted panel answers `401`, and a retry that
   * ignored that would spin forever against a token that will never be accepted again. That error
   * is thrown, which is the signal a caller needs.
   */
  reconnect?: boolean
}

/**
 * How long to wait before the `n`-th reconnect attempt: 250 ms doubling, capped at 30 s.
 *
 * Deliberately short at the start (a panel restart is back within a second) and bounded (a panel that
 * is down for an hour must not leave a script sleeping for ever between checks). A caller can replace
 * it through `clientOptions.retryDelayMs`, which the tests do so they do not wait it out.
 */
function defaultRetryDelay(attempt: number): Promise<void> {
  const ms = Math.min(250 * 2 ** Math.max(0, attempt - 1), 30_000)
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    // A pending reconnect must not be the reason a one-shot script cannot exit.
    timer.unref?.()
  })
}

/**
 * A refusal no retry can fix: the credential is not accepted, so every attempt is another `401`.
 *
 * `AUTH_REQUIRED`, `AUTH_UNARMED` and `AUTH_DISABLED_REMOTE` all mean "this caller may not", not "the
 * panel is briefly away" — retrying them hides the one fact the caller needs, and against a restarted
 * panel with a rotated token it retries for ever.
 */
function isCredentialRefusal(error: unknown): boolean {
  return error instanceof HomeHostedError
    && error.status === 401
    && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_UNARMED' || error.code === 'AUTH_DISABLED_REMOTE')
}

/** A token is sent only over https, or to this machine, unless the caller opted out. */
function assertTokenTransport(baseUrl: string, options: ClientOptions): void {
  if (options.token === undefined || options.allowInsecureToken === true)
    return
  let url: URL
  try {
    url = new URL(baseUrl)
  }
  catch {
    throw new TypeError(`home-hosted/client: baseUrl "${baseUrl}" is not an absolute URL`)
  }
  if (url.protocol === 'https:' || isLoopbackHost(url.hostname))
    return
  throw new TypeError(`home-hosted/client: refusing to send the API token over plain http to ${url.host} — use https, a loopback address, or pass allowInsecureToken: true`)
}

export function createClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  assertTokenTransport(baseUrl, options)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay
  const headers = (): Record<string, string> => ({
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...options.headers,
  })

  const rpc = hc<AppType>(baseUrl, { fetch: fetcher, headers })
  // Every route a client means lives under `/api`; rooting the client there keeps calls to
  // `hh.api.servers` rather than `hh.api.api.servers`.
  const api = rpc.api

  /** Awaits a call, returning its JSON body or throwing a `HomeHostedError`. */
  async function json<T>(call: Promise<{ ok: boolean, status: number, json: () => Promise<T> }>): Promise<T> {
    const response = await call
    if (!response.ok)
      throw await toError(response as unknown as Response)
    return await response.json()
  }

  /** The live feed: the first frame is always `hello` with the full state. */
  async function* events(query: EventsQuery = {}): AsyncGenerator<ClientStreamFrame> {
    const base = (since: number | undefined): string => {
      const params = new URLSearchParams()
      if (query.workspace !== undefined)
        params.set('workspace', query.workspace)
      if (query.serverId !== undefined)
        params.set('serverId', query.serverId)
      if (query.logs === false)
        params.set('logs', '0')
      if (since !== undefined)
        params.set('since', String(since))
      return params.size > 0 ? `?${params}` : ''
    }

    // The last `id:` line delivered, which is what a resume replays from. Taken from the frame the
    // consumer actually received, never from a frame it skipped as a `ping`.
    let resumeFrom = query.since
    let attempt = 0
    for (;;) {
      let failed: unknown = null
      try {
        const response = await fetcher(`${baseUrl}/api/events${base(resumeFrom)}`, {
          headers: { ...headers(), accept: 'text/event-stream' },
          signal: query.signal,
        })
        if (!response.ok || response.body === null)
          throw await toError(response)

        for await (const frame of readEventStream(response.body)) {
          const id = frame.id !== undefined && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined
          if (id !== undefined)
            resumeFrom = id
          if (frame.event === 'ping' || frame.data === '')
            continue
          // The `id` travels beside the payload, not inside it: the payload is the wire frame, and a
          // consumer persisting a cursor across a restart needs the sequence the transport assigned.
          yield { ...(JSON.parse(frame.data) as SseMessage), ...(id === undefined ? {} : { id }) }
        }
      }
      catch (error) {
        // A credential refusal is the caller's to handle: retrying it spins against a token the
        // panel will never accept, and hides the one fact a script needs.
        if (!query.reconnect || query.signal?.aborted === true || isCredentialRefusal(error))
          throw error
        failed = error
      }
      if (!query.reconnect || query.signal?.aborted === true)
        return
      attempt += 1
      await retryDelay(attempt)
      // The wait is the longest thing here, so the abort is re-checked after it as well as in the
      // request: a caller that gave up during the backoff must not get one more attempt. Read
      // through a local because `query.reconnect`'s narrowing above makes the whole query look
      // settled to the compiler.
      const signal = query.signal
      if (signal !== undefined && signal.aborted)
        return
      // A connection that delivered frames was healthy; a later drop starts the backoff over.
      if (failed === null)
        attempt = 1
    }
  }

  return { api, rpc, json, events, baseUrl }
}

export type HomeHostedClient = ReturnType<typeof createClient>

/**
 * One frame as `events()` delivers it: the wire message, plus the sequence number the stream assigned
 * it (`id`), which is what a later `events({ since })` resumes from. `id` is absent on a frame the
 * panel sent without one (an older panel, which has no resumable stream at all).
 */
export type ClientStreamFrame = SseMessage & { id?: number }

async function toError(response: Response): Promise<HomeHostedError> {
  let body: unknown = null
  try {
    body = await response.json()
  }
  catch {
    // not JSON: the status is all there is
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string' ? record.error : `request failed with ${response.status}`
  return new HomeHostedError(message, response.status, typeof record.code === 'string' ? record.code : 'HTTP_ERROR', record.detail)
}

/**
 * Cancels the body when the consumer stops reading early.
 *
 * `releaseLock()` alone does not: it drops our handle on the stream while the connection stays open,
 * so a `for await (const frame of hh.events())` that `break`s after one frame left the request running
 * — the panel kept a subscriber slot, and a Node script could not exit because the socket kept the
 * event loop alive. Measured against a real listener: `1 of 1` connections still open after leaving
 * the loop, and a plain-process run stayed awake until `process.exit()`.
 *
 * `cancel()` is a no-op once the stream has ended on its own, so this is safe on the normal path too.
 */
async function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {
    // Already errored or gone: the connection is closed either way, which is the point.
  }
}

/**
 * Parses a `text/event-stream` body into `{ event, data }` frames (the subset the panel sends).
 *
 * `id` is the frame's `id:` line — the panel-wide sequence — and it is on every frame the panel
 * sends. A consumer that keeps the last one can hand it back as `events({ since })` to resume. It is
 * **absent**, not `null`, on a frame that carried no `id:` line, so a body without one yields the
 * same objects it always did.
 */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string, data: string, id?: string }> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let id: string | null = null
  let data: string[] = []
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        return
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (data.length > 0)
            yield { event, data: data.join('\n'), ...(id === null ? {} : { id }) }
          event = 'message'
          id = null
          data = []
        }
        else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        }
        else if (line.startsWith('id:')) {
          // The SSE grammar strips one leading space after the colon.
          id = line.slice(3).replace(/^ /, '')
        }
        else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
  }
  finally {
    await cancelBody(reader)
    reader.releaseLock()
  }
}
