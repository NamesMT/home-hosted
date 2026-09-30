import type { AppDeps } from '#src/app'
import type { ProxyConfig } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { ConfigError } from '#src/config/settings'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { checkProxyExposure } from '#src/services/exposure'
import { validateProxyConfig } from '#src/services/proxy'
import {
  proxyCertificateUploadSchema,
  proxyConfigSchema,
  proxyEngineInstallSchema,
  proxyPatchSchema,
  proxyViewSchema,
} from '#src/shared/contracts'

const certificateParam = type({ id: '/^[a-z0-9][a-z0-9_-]*$/' })

/** The patch, applied to the live config the way the store would apply it. */
function candidateConfig(current: ProxyConfig, patch: Record<string, unknown>): ProxyConfig {
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined)
      merged[key] = value
  }
  const parsed = proxyConfigSchema(merged)
  if (parsed instanceof type.errors)
    throw new DetailedError(parsed.summary, { statusCode: 400, code: 'INVALID_PROXY' })
  return parsed
}

/**
 * The reverse proxy is panel-wide: one engine, one route table, one set of ports.
 * Routes name a workspace for the entries they point at, because an id is only
 * unique inside one.
 */
export function createProxyRoute(deps: AppDeps) {
  const proxy = () => deps.proxy
  const view = () => proxy().view()

  /** Everything that has to hold before a change is written to disk. */
  const guard = (candidate: ProxyConfig): void => {
    const problems = validateProxyConfig(candidate)
    if (problems.length > 0)
      throw new DetailedError(`invalid reverse proxy configuration: ${problems.join('; ')}`, { statusCode: 400, code: 'INVALID_PROXY', detail: problems })

    const exposure = checkProxyExposure(candidate, deps.panel.settings.control.auth.enabled, deps.auth.passwordSet, deps.auth.usingDefaultPassword)
    if (exposure !== null)
      throw new DetailedError(exposure, { statusCode: 400, code: 'PROXY_EXPOSURE_BLOCKED' })
  }

  /** A settings edit takes effect at once: apply to a running engine, start or stop otherwise. */
  const reconcile = async (): Promise<void> => {
    const config = proxy().config
    try {
      if (!config.enabled) {
        // Switching it off has to end the engine: `status()` calls a disabled proxy
        // "off" by definition, so it can never be the thing that decides this.
        await proxy().stop()
        return
      }
      if (proxy().status().state === 'running')
        await proxy().apply()
      else
        await proxy().start()
    }
    catch (error) {
      // The client gets the failure; the page gets it too, on the next frame.
      proxy().recordError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  return appFactory.createApp()
    .get(
      '/proxy',
      describeRoute({
        tags: ['proxy'],
        summary: 'Reverse proxy policy, engine and resolved routes',
        responses: { 200: { description: 'The proxy view', content: jsonBody(proxyViewSchema) } },
      }),
      c => c.json(view()),
    )

    .patch(
      '/proxy',
      describeRoute({
        tags: ['proxy'],
        summary: 'Change the reverse proxy settings or its route table',
        responses: { 200: { description: 'Saved and applied', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('json', proxyPatchSchema),
      async (c) => {
        const patch = c.req.valid('json')
        const candidate = candidateConfig(proxy().config, patch)
        guard(candidate)

        try {
          proxy().update(patch)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_PROXY' })
          throw error
        }

        await reconcile()
        return c.json(view())
      },
    )

    .post(
      '/proxy/engine',
      describeRoute({
        tags: ['proxy'],
        summary: 'Install or update the proxy engine',
        responses: { 200: { description: 'Installed', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('json', proxyEngineInstallSchema),
      async (c) => {
        await proxy().install(c.req.valid('json').version)
        await reconcile()
        return c.json(view())
      },
    )

    .post(
      '/proxy/start',
      describeRoute({
        tags: ['proxy'],
        summary: 'Start the proxy engine',
        responses: { 200: { description: 'Started', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      async (c) => {
        await proxy().start()
        return c.json(view())
      },
    )

    .post(
      '/proxy/stop',
      describeRoute({
        tags: ['proxy'],
        summary: 'Stop the proxy engine',
        responses: { 200: { description: 'Stopped', content: jsonBody(proxyViewSchema) } },
      }),
      async (c) => {
        await proxy().stop()
        return c.json(view())
      },
    )

    .post(
      '/proxy/apply',
      describeRoute({
        tags: ['proxy'],
        summary: 'Regenerate and reload the engine configuration',
        responses: { 200: { description: 'Applied', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      async (c) => {
        await proxy().apply()
        return c.json(view())
      },
    )

    .post(
      '/proxy/revert',
      describeRoute({
        tags: ['proxy'],
        summary: 'Go back to the engine configuration that applied before the last one',
        responses: { 200: { description: 'Reverted', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      async (c) => {
        await proxy().revert()
        return c.json(view())
      },
    )

    .put(
      '/proxy/certificates/:id',
      describeRoute({
        tags: ['proxy'],
        summary: 'Store a certificate pair that routes with `tls: "manual"` serve',
        responses: { 200: { description: 'Stored', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('param', certificateParam),
      validate('json', proxyCertificateUploadSchema),
      async (c) => {
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const saved = proxy().saveCertificate(id, body.label, body.certificate, body.privateKey)
        if (!saved.ok)
          throw new DetailedError(saved.error ?? 'the certificate pair was rejected', { statusCode: 400, code: 'INVALID_CERTIFICATE' })

        if (proxy().status().state === 'running')
          await proxy().apply()
        return c.json(view())
      },
    )

    .delete(
      '/proxy/certificates/:id',
      describeRoute({
        tags: ['proxy'],
        summary: 'Remove an uploaded certificate pair',
        responses: { 200: { description: 'Removed', content: jsonBody(proxyViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('param', certificateParam),
      async (c) => {
        proxy().clearCertificate(c.req.valid('param').id)
        if (proxy().status().state === 'running')
          await proxy().apply()
        return c.json(view())
      },
    )
}
