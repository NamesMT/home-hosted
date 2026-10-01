import type { AppDeps } from '#src/app'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { isLoopbackRequest } from '#src/middleware/loopback'

/**
 * The ACMEProxy endpoint the reverse-proxy engine calls for a DNS-01 challenge.
 *
 * Deliberately outside `/api` — the engine is not a session — and outside `/_hh`,
 * which carries the panel's own local token. Two things guard it: only a loopback
 * peer is answered, and the engine must present the Basic credentials the panel
 * generated for it. The engine never holds DNS credentials; this endpoint writes
 * the record through the workspace account a route names.
 */
export function createAcmeChallengeRoute(deps: AppDeps) {
  return appFactory.createApp()
    .post(
      '/:action',
      describeRoute({
        tags: ['proxy'],
        summary: 'Answer one ACME DNS-01 challenge (local engine only)',
        responses: { 200: { description: 'Written or removed' }, 401: { description: 'Bad credentials' }, 403: { description: 'Not a local caller' } },
      }),
      async (c) => {
        if (!isLoopbackRequest(c)) {
          logger.warn('proxy:    refused a DNS-01 challenge from a non-loopback caller')
          return c.json({ error: 'only this machine may answer a challenge' }, 403)
        }
        return await deps.challenge.handle(c.req.raw, c.req.param('action') ?? '')
      },
    )
}
