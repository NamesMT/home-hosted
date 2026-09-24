import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { afterResponse } from '#src/helpers/deferred'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { buildControlView } from '#src/services/state'
import { tlsUploadSchema } from '#src/shared/contracts'

/**
 * Uploads the PEM pair used for https on the control panel.
 *
 * When TLS is already enabled the listener has to be rebuilt with the new pair,
 * which kills the connection serving this request — so the swap is deferred, and
 * the response tells the client where the panel will be.
 */
export function createTlsRoute(deps: AppDeps) {
  const review = () => ({
    control: buildControlView(deps.store, deps.auth, deps.controlServer.endpoint, deps.tls),
    rebinding: deps.store.config.control.tls.enabled,
    targetUrl: deps.controlServer.endpoint.url,
  })

  return appFactory.createApp()
    .post(
      '/settings/tls',
      describeRoute({
        tags: ['tls'],
        summary: 'Upload the certificate and key the panel should serve',
        responses: { 200: { description: 'Stored; the panel may be moving to https' }, 400: ERROR_RESPONSES[400] },
      }),
      validate('json', tlsUploadSchema),
      (c) => {
        const body = c.req.valid('json')
        const saved = deps.tls.save(body.certificate, body.privateKey)
        if (!saved.ok)
          throw new DetailedError(saved.error ?? 'the certificate pair was rejected', { statusCode: 400, code: 'INVALID_CERTIFICATE' })

        if (deps.store.config.control.tls.enabled) {
          afterResponse(async () => {
            const result = await deps.controlServer.restart()
            if (!result.ok)
              logger.error(`could not reload TLS: ${result.error ?? 'unknown error'}`)
            else logger.info(`control panel listening on ${deps.controlServer.endpoint.url} (https)`)
          }, error => logger.error('tls reload failed', error))
        }

        return c.json(review())
      },
    )

    .delete(
      '/settings/tls',
      describeRoute({
        tags: ['tls'],
        summary: 'Remove the certificate pair',
        responses: { 200: { description: 'Removed' } },
      }),
      (c) => {
        deps.tls.clear()
        if (deps.store.config.control.tls.enabled) {
          afterResponse(async () => {
            await deps.controlServer.restart()
          }, error => logger.error('tls reload failed', error))
        }
        return c.json(review())
      },
    )
}
