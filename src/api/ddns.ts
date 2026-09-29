import type { AppDeps } from '#src/app'
import type { WorkspaceRuntime } from '#src/services/panel'
import type { DdnsConfig } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { ConfigError } from '#src/config/store'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { ddnsProvider, ddnsProviderInfos, validateDdnsConfig } from '#src/providers/ddns'
import { ddnsConfigSchema, ddnsCredentialsSchema, ddnsViewSchema } from '#src/shared/contracts'

const accountParam = type({ id: '/^[a-z0-9][a-z0-9_-]*$/' })

/**
 * Dynamic DNS is configured as one whole block, not as settings patches: its
 * accounts and hostnames are lists, and a key-by-key merge would leave a removed
 * account or hostname behind. Provider credentials never come back over the API —
 * the view only says which accounts have them.
 *
 * It is workspace-scoped: each workspace keeps its own hostnames, credentials and
 * DDNS state under its directory.
 */
export function createDdnsRoute(deps: AppDeps) {
  const view = (runtime: WorkspaceRuntime) => {
    const config = runtime.store.ddns
    return {
      config,
      status: runtime.ddns.view,
      providers: ddnsProviderInfos(),
      // An id with a stored secret counts as saved even before the account itself is
      // — that is the draft flow. Once the config declares it, the provider has to
      // match the entry, or the badge would claim credentials that cannot be used.
      credentials: runtime.secrets.ddnsAccountIds.filter((id) => {
        const account = config.accounts.find(entry => entry.id === id)
        return account === undefined || runtime.secrets.getDdnsCredentials(id, account.provider) !== null
      }),
    }
  }

  return appFactory.createApp()
    .get(
      '/ddns',
      describeRoute({
        tags: ['ddns'],
        summary: 'Dynamic DNS policy, live state and the providers this build knows',
        responses: { 200: { description: 'The DDNS view', content: jsonBody(ddnsViewSchema) } },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json(view(runtime))
      },
    )

    .put(
      '/ddns',
      describeRoute({
        tags: ['ddns'],
        summary: 'Replace the dynamic DNS block',
        responses: { 200: { description: 'Saved', content: jsonBody(ddnsViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', ddnsConfigSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const config: DdnsConfig = c.req.valid('json')
        const problems = validateDdnsConfig(config)
        if (problems.length > 0)
          throw new DetailedError(`invalid DDNS configuration: ${problems.join('; ')}`, { statusCode: 400, code: 'INVALID_DDNS', detail: problems })

        try {
          runtime.store.updateDdns(config)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_DDNS' })
          throw error
        }

        // A removed account takes its stored secret with it; without this, a token
        // typed for a draft that was never saved would sit in the file forever.
        const pruned = runtime.secrets.pruneDdnsCredentials(config.accounts.map(account => account.id))
        if (pruned > 0)
          logger.info(`ddns: dropped stored credentials for ${pruned} account(s) the config no longer declares`)

        // A config edit is a reason to look again now, not on the next interval.
        runtime.ddns.refresh()
        return c.json(view(runtime))
      },
    )

    .put(
      '/ddns/credentials/:id',
      describeRoute({
        tags: ['ddns'],
        summary: 'Store the credentials of one DDNS account',
        responses: { 200: { description: 'Stored', content: jsonBody(ddnsViewSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', accountParam),
      validate('json', ddnsCredentialsSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const { provider: providerId, credentials } = c.req.valid('json')

        // The account itself may still be an unsaved draft; only its provider is needed.
        const provider = ddnsProvider(providerId)
        if (provider === null)
          throw new DetailedError(`unknown DDNS provider "${providerId}"`, { statusCode: 400, code: 'UNKNOWN_DDNS_PROVIDER' })

        const problem = provider.validate(credentials)
        if (problem !== null)
          throw new DetailedError(`${provider.label}: ${problem}`, { statusCode: 400, code: 'INVALID_DDNS_CREDENTIALS' })

        runtime.secrets.setDdnsCredentials(id, providerId, credentials)
        runtime.ddns.refresh()
        return c.json(view(runtime))
      },
    )

    .delete(
      '/ddns/credentials/:id',
      describeRoute({
        tags: ['ddns'],
        summary: 'Forget the credentials of one DDNS account',
        responses: { 200: { description: 'Removed', content: jsonBody(ddnsViewSchema) } },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', accountParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        runtime.secrets.clearDdnsCredentials(c.req.valid('param').id)
        runtime.ddns.refresh()
        return c.json(view(runtime))
      },
    )

    .post(
      '/ddns/check',
      describeRoute({
        tags: ['ddns'],
        summary: 'Run a dynamic DNS pass now',
        responses: { 200: { description: 'The pass, with its result', content: jsonBody(ddnsViewSchema) } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        await runtime.ddns.run({ force: true })
        return c.json(view(runtime))
      },
    )
}
