import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { afterResponse } from '#src/helpers/deferred'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { isLoopbackRequest } from '#src/middleware/loopback'

/**
 * The local control channel used by `home-hosted down`.
 *
 * It is deliberately outside `/api` (so no session is needed) and guarded by a
 * token that only the owner of `run.json` can read, plus a loopback check: a
 * different local user, or anyone on the network, gets nothing.
 */
export function createControlRoute(deps: AppDeps) {
  return appFactory.createApp()
    .post(
      '/shutdown',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop the panel and everything it supervises (local token required)',
        responses: { 200: { description: 'Stopping' }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      (c) => {
        const token = c.req.header('x-home-hosted-token')
        if (token === undefined || token !== deps.runtimeToken)
          throw new DetailedError('invalid token', { statusCode: 403, code: 'INVALID_TOKEN' })
        if (!isLoopbackRequest(c))
          throw new DetailedError('only this machine may stop the control panel', { statusCode: 403, code: 'NOT_LOOPBACK' })

        // Deferred: the answer has to reach `down` before the process goes away.
        afterResponse(deps.onShutdown, error => logger.error('shutdown failed', error))

        return c.json({ ok: true })
      },
    )
}
