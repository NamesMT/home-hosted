import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import process from 'node:process'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { homeFingerprint } from '#src/helpers/paths'
import { secretEqual } from '#src/helpers/secret-compare'
import { isLoopbackRequest, requestIdentity } from '#src/middleware/auth'
import { healthResponseSchema } from '#src/shared/contracts'
import { needsAttention } from '#src/shared/server-attention'

/**
 * Liveness for external monitors. Mounted outside `/api`, so it answers without a
 * session: it reports whether the panel itself is serving, and 503 while any entry
 * `needsAttention` — crashed, blocked on its port, given up on by the panel, or running and
 * failing its own health check. Server details are only included for an authenticated caller.
 */
export function createHealthRoute(deps: AppDeps) {
  const home = homeFingerprint()
  return appFactory.createApp()
    .get(
      '/healthz',
      describeRoute({
        tags: ['panel'],
        summary: 'Liveness for monitors — no session required',
        responses: {
          200: {
            description: 'Serving',
            content: jsonBody(healthResponseSchema),
          },
          503: {
            description: 'An entry needs attention: crashed, blocked on its port, stopped by the panel, or running and unhealthy',
            /**
             * The same schema as the 200, because a degraded panel answers the same document with
             * `status: "degraded"`. Leaving `content` off made `finishSpec` stamp the error envelope
             * onto it — every declared status ≥ 400 gets one — so the published spec told a generated
             * monitor client to expect `{ message, code }` from the one endpoint whose whole job is
             * machine consumption, and a degraded-but-working panel read as unparseable.
             */
            content: jsonBody(healthResponseSchema),
          },
        },
      }),
      (c) => {
        const state = deps.panel.getState()
        // Every workspace's servers, so a crash anywhere degrades the panel.
        const servers = state.workspaces.flatMap(workspace => workspace.servers)
        // One predicate, shared with the UIs, so this endpoint and the pages cannot disagree about
        // what "broken" means — they had, in both directions. See `#src/shared/server-attention`.
        const broken = servers.filter(needsAttention)
        // Detail is for a signed-in browser, an API token, or the local channel's token. The status
        // line stays public, which is the whole point of a monitor endpoint.
        //
        // The local token is a **different secret** from the API bearer token, and it is the one
        // `run.json` hands the CLI. Without it here `status` could see "degraded" but not the count,
        // while `usage` read the same numbers over `/_hh` — the gap was `status` using a channel that
        // refused it, not the data being unavailable.
        const authenticated = requestIdentity(c, deps.auth).authenticated || localTokenValid(c, deps)

        return c.json({
          status: broken.length > 0 ? 'degraded' : 'ok',
          uptimeMs: Math.round(process.uptime() * 1000),
          ...(authenticated
            ? {
                servers: {
                  total: servers.length,
                  running: servers.filter(server => server.status === 'running').length,
                  crashed: servers.filter(server => server.status === 'crashed').length,
                  unhealthy: servers.filter(server => server.health === 'unhealthy').length,
                },
                hostAlerts: state.host.alerts,
              }
            : {}),
          // Which home this is, for a CLI on this machine that has no `run.json` to go by: two homes
          // may share a port, and only this tells their panels apart. A hash, so it names no path.
          ...(isLoopbackRequest(c) ? { home } : {}),
        }, broken.length > 0 ? 503 : 200)
      },
    )
}

/**
 * Whether the caller proved itself with the local channel's token.
 *
 * The same secret `assertLocalCall` reads, checked the same constant-time way — it means "a process
 * that can read this home's `run.json`", which is exactly the trust the CLI already has. It needs a
 * loopback peer too, and loopback alone is deliberately not enough: any local user could reach the port.
 */
function localTokenValid(c: Context, deps: AppDeps): boolean {
  // The local channel's token is only ever honoured from this machine, as on `/_hh`: a copy that
  // leaked off the box must not read anything through a proxy or from the LAN.
  if (!isLoopbackRequest(c))
    return false
  const token = c.req.header('x-home-hosted-token')
  return token !== undefined && secretEqual(token, deps.runtimeToken)
}
