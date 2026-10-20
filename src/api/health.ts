import type { AppDeps } from '#src/app'
import process from 'node:process'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { requestIdentity } from '#src/middleware/auth'
import { healthResponseSchema } from '#src/shared/contracts'

/**
 * Liveness for external monitors. Mounted outside `/api`, so it answers without a
 * session: it reports whether the panel itself is serving, and 503 when any server
 * has crashed, or a running one is failing its own health check. Server details are
 * only included for an authenticated caller.
 */
export function createHealthRoute(deps: AppDeps) {
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
          503: { description: 'A server has crashed, or a running one is unhealthy' },
        },
      }),
      (c) => {
        const state = deps.panel.getState()
        // Every workspace's servers, so a crash anywhere degrades the panel.
        const servers = state.workspaces.flatMap(workspace => workspace.servers)
        // A crash degrades the panel whoever started the entry — `autostart` is a boot
        // preference, not ownership of the failure. An operator's stop is not a problem, and
        // `stopped` is what it sets. But the panel also *stops* an entry that cannot serve once
        // its health budget is spent, and that is a broken service: `stoppedByPanel` is what tells
        // the two apart, since the status alone cannot. The `running` test is load-bearing for
        // `health`, which keeps its last value through a stop.
        const broken = servers.filter(server =>
          server.status === 'crashed'
          || server.stoppedByPanel === true
          || (server.status === 'running' && server.health === 'unhealthy'),
        )
        // Detail is for a signed-in browser or an API token; the status line itself
        // stays public, which is the whole point of a monitor endpoint.
        const authenticated = requestIdentity(c, deps.auth).authenticated

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
        }, broken.length > 0 ? 503 : 200)
      },
    )
}
