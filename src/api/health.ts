import type { AppDeps } from '#src/app'
import process from 'node:process'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { requestIdentity } from '#src/middleware/auth'
import { healthResponseSchema } from '#src/shared/contracts'

/**
 * Liveness for external monitors. Mounted outside `/api`, so it answers without a
 * session: it reports whether the panel itself is serving, and 503 when an
 * autostart server has crashed. Server details are only included for an
 * authenticated caller.
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
          503: { description: 'An autostart server has crashed' },
        },
      }),
      (c) => {
        const state = deps.panel.getState()
        // Every workspace's servers, so a crash anywhere degrades the panel.
        const servers = state.workspaces.flatMap(workspace => workspace.servers)
        const broken = servers.filter(server => server.config.autostart && server.status === 'crashed')
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
