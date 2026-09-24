import type { AppDeps } from '#src/app'
import process from 'node:process'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'

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
            content: jsonBody(type({
              'status': '"ok" | "degraded"',
              'uptimeMs': 'number',
              'servers?': type({ total: 'number', running: 'number', crashed: 'number', unhealthy: 'number' }),
              'hostAlerts?': 'string[]',
            })),
          },
          503: { description: 'An autostart server has crashed' },
        },
      }),
      (c) => {
        const state = deps.supervisor.getState()
        const broken = state.servers.filter(server => server.config.autostart && server.status === 'crashed')
        const authenticated = deps.auth.validate(deps.auth.tokenFromCookie(c.req.header('cookie'))) !== null

        return c.json({
          status: broken.length > 0 ? 'degraded' : 'ok',
          uptimeMs: Math.round(process.uptime() * 1000),
          ...(authenticated
            ? {
                servers: {
                  total: state.servers.length,
                  running: state.servers.filter(server => server.status === 'running').length,
                  crashed: state.servers.filter(server => server.status === 'crashed').length,
                  unhealthy: state.servers.filter(server => server.health === 'unhealthy').length,
                },
                hostAlerts: state.host.alerts,
              }
            : {}),
        }, broken.length > 0 ? 503 : 200)
      },
    )
}
