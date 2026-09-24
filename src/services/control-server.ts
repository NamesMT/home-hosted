import type { Server } from 'srvx'
import type { Bind } from '#src/shared/contracts'
import { serve } from 'srvx'
import { bindHost, displayHost } from '#src/helpers/bind'
import { isPortFree } from '#src/providers/port'

export interface ControlEndpoint {
  /** Configured bind value: `local` | `lan` | ipv4. */
  host: Bind
  port: number
  /** Address actually bound. */
  bindHost: string
  url: string
  protocol: 'http' | 'https'
}

export interface ControlServerOptions {
  /** A thunk, so the app can be built after this server exists. */
  fetch: (request: Request) => Response | Promise<Response>
  /** Read per (re)bind, so a settings change applies without a restart. */
  trustProxy: () => boolean
  /** The uploaded PEM pair, or null for plain http. Read per (re)bind. */
  tls: () => { cert: string, key: string } | null
}

export interface RebindResult {
  ok: boolean
  error?: string
}

/**
 * Owns the control panel's own listener, so the settings page can move it to a
 * new host/port without stopping the supervised servers.
 */
export class ControlServer {
  readonly endpoint: ControlEndpoint
  private server: Server | null = null

  constructor(
    private readonly options: ControlServerOptions,
    initial: { host: Bind, port: number, tls?: boolean },
  ) {
    this.endpoint = {
      host: initial.host,
      port: initial.port,
      bindHost: bindHost(initial.host),
      url: `${initial.tls ? 'https' : 'http'}://${displayHost(initial.host)}:${initial.port}`,
      protocol: initial.tls ? 'https' : 'http',
    }
  }

  get liveHost(): string {
    return this.endpoint.host
  }

  get livePort(): number {
    return this.endpoint.port
  }

  async start(): Promise<void> {
    await this.listenWithRetry(this.endpoint.host, this.endpoint.port)
  }

  /** Re-listens on the same endpoint, e.g. after `trustProxy` changed. */
  async restart(): Promise<RebindResult> {
    const { host, port } = this.endpoint
    await this.close()
    try {
      await this.listenWithRetry(host, port)
      return { ok: true }
    }
    catch (error) {
      return { ok: false, error: `restart failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Moves the listener. Preflights the new port, and restores the previous
   * endpoint if the new one refuses to bind — otherwise the panel would become
   * unreachable and need a manual restart.
   */
  async rebind(next: { host: Bind, port: number }): Promise<RebindResult> {
    if (next.host === this.endpoint.host && next.port === this.endpoint.port)
      return { ok: true }

    const previous = { host: this.endpoint.host, port: this.endpoint.port }
    if (next.port !== previous.port && !(await isPortFree(next.port))) {
      return { ok: false, error: `port ${next.port} is already in use` }
    }

    await this.close()
    try {
      await this.listenWithRetry(next.host, next.port)
      return { ok: true }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.listenWithRetry(previous.host, previous.port)
      }
      catch {
        // Nothing left to fall back to; the caller surfaces the original error.
      }
      return { ok: false, error: `rebind failed: ${message}` }
    }
  }

  async close(force = true): Promise<void> {
    const server = this.server
    this.server = null
    if (!server)
      return
    try {
      await server.close(force)
    }
    catch {
      // Already gone.
    }
  }

  /** A just-closed listener can refuse a rebind for a moment, so retry briefly. */
  private async listenWithRetry(host: Bind, port: number, attempts = 3): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.listen(host, port)
        return
      }
      catch (error) {
        lastError = error
        if (attempt < attempts)
          await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    throw lastError
  }

  private async listen(host: Bind, port: number): Promise<void> {
    const tls = this.options.tls()
    const server = serve({
      fetch: this.options.fetch,
      port,
      hostname: bindHost(host),
      trustProxy: this.options.trustProxy(),
      ...(tls === null ? {} : { tls: { cert: tls.cert, key: tls.key } }),
    })

    // Without a listener, a failed bind would surface as an unhandled 'error' event.
    const nodeServer = server.node?.server
    const failure = new Promise<Error>((resolve) => {
      nodeServer?.once('error', error => resolve(error as Error))
    })

    const outcome = await Promise.race([
      server.ready().then(() => null).catch((error: unknown) => error as Error),
      failure,
    ])
    if (outcome !== null)
      throw outcome

    this.server = server
    this.endpoint.host = host
    this.endpoint.port = port
    this.endpoint.bindHost = bindHost(host)
    this.endpoint.protocol = tls === null ? 'http' : 'https'
    this.endpoint.url = `${this.endpoint.protocol}://${displayHost(host)}:${port}`
  }
}
