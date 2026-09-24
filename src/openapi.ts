import fs from 'node:fs'
import { Scalar } from '@scalar/hono-api-reference'
import { openAPIRouteHandler } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'

const PREFIX = '/openapi'

/**
 * The machine-readable contract, generated from the same ArkType schemas the
 * routes validate with — one source of truth, no second set of DTOs to drift.
 * `/openapi/ui` is a browsable reference (Scalar) and needs no session, since a
 * UI author has to be able to read it before they can log in.
 */
/** The version the package was built with, so the spec never drifts from it. */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

export function setupOpenAPI(app: Parameters<typeof openAPIRouteHandler>[0]) {
  return appFactory.createApp()
    .get(
      `${PREFIX}/spec.json`,
      openAPIRouteHandler(app, {
        documentation: {
          info: {
            title: 'home-hosted',
            version: packageVersion(),
            description: 'Control plane for the processes you host at home: servers, logs, vitals, backups and settings.',
          },
          tags: [
            { name: 'panel', description: 'Snapshot, health and the local shutdown channel' },
            { name: 'servers', description: 'The processes being supervised' },
            { name: 'logs', description: 'Live and persisted logs' },
            { name: 'backups', description: 'Archives of config, secrets, TLS and data paths' },
            { name: 'auth', description: 'Sessions and the panel password' },
            { name: 'notifications', description: 'Telegram delivery' },
            { name: 'tls', description: 'The panel certificate' },
          ],
        },
      }),
    )
    .get(
      `${PREFIX}/ui`,
      Scalar({ theme: 'deepSpace', url: `${PREFIX}/spec.json` }),
    )
}
