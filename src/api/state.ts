import type { AppDeps } from '#src/app'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { appStateSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'

/**
 * This route takes no query keys, and says so.
 *
 * Not `workspaceQuerySchema`: `GET /api/state` is panel-wide — every workspace in one payload — so
 * accepting `?workspace=` would promise a narrowing it does not do. Declaring nothing, strictly, is
 * what makes docs/API.md's promise true here: a key the route does not declare is refused, so a
 * `?worspace=staging` typo is a `400` naming the key rather than a silent full snapshot that reads
 * as if the narrowing had been applied.
 */
const stateQuery = lazy(() => type({}).onUndeclaredKey('reject'))

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
      validate('query', stateQuery),
      c => c.json(deps.panel.getState()),
    )
}
