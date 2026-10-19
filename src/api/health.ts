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
 * autostart server has crashed, or a running one is failing its own health check.
 * Server details are only included for an authenticated caller.
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
          503: { description: 'An autostart server has crashed, or a running one is unhealthy' },
        },
      }),
      (c) => {
        const state = deps.panel.getState()
        // Every workspace's servers, so a crash anywhere degrades the panel.
        const servers = state.workspaces.flatMap(workspace => workspace.servers)
        // Two things a monitor has to see, and nothing else.
        //
        // A `crashed` entry is broken whoever started it: filtering on `autostart` hid a
        // manually-started server that had died, which is precisely the case an external monitor
        // exists for. The deliberate-stop worry that motivated the filter does not apply —
        // stopping sets `stopped`, never `crashed` (`serverStatusSchema`), so a server someone
        // switched off cannot degrade the panel.
        //
        // An `unhealthy` *running* entry is the other half: it is up, so nothing else here would
        // report it. `status === 'running'` is part of that test on purpose — `health` keeps its
        // last value through a stop.
        const broken = servers.filter(server =>
          server.status === 'crashed'
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
