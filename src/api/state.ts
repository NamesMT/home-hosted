import type { AppDeps } from '#src/app'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { appStateSchema } from '#src/shared/contracts'

/** The whole panel in one payload: config, live server state and host vitals. */
export function createStateRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/state',
      describeRoute({
        tags: ['panel'],
        summary: 'Full snapshot of the panel',
        responses: { 200: { description: 'The snapshot', content: jsonBody(appStateSchema) } },
      }),
      c => c.json(deps.supervisor.getState()),
    )
}
