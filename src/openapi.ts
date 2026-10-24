import { openAPIRouteHandler } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { appVersion } from '#src/helpers/version'
import { openApiReferencePage } from '#src/openapi-reference'

const PREFIX = '/openapi'

/**
 * The machine-readable contract, generated from the same ArkType schemas the
 * routes validate with — one source of truth, no second set of DTOs to drift.
 * `/openapi/ui` is the browsable reference and needs no session, since a UI
 * author has to be able to read it before they can log in.
 */
/** The version the package was built with, so the spec never drifts from it. */
export function setupOpenAPI(app: Parameters<typeof openAPIRouteHandler>[0]) {
  return appFactory.createApp()
    .get(
      `${PREFIX}/spec.json`,
      openAPIRouteHandler(app, {
        documentation: {
          info: {
            title: 'home-hosted',
            version: appVersion(),
            description: 'Control plane for the processes you host at home: servers, logs, vitals, backups and settings.',
          },
          tags: [
            { name: 'panel', description: 'Snapshot, health and the local shutdown channel' },
            { name: 'servers', description: 'The processes being supervised' },
            { name: 'logs', description: 'Live and persisted logs' },
            { name: 'workspaces', description: 'The ownership boundary: one scope per setup' },
            { name: 'backups', description: 'Archives of config, secrets, TLS and data paths' },
            { name: 'auth', description: 'Sessions and the panel password' },
            { name: 'notifications', description: 'Telegram delivery and webhook destinations' },
            { name: 'ddns', description: 'Dynamic DNS accounts and hostnames' },
            { name: 'proxy', description: 'The reverse proxy: engine, routes and certificates' },
            { name: 'tls', description: 'The panel certificate' },
          ],
          /**
           * The auth scheme, so a generated client can be told how to send a credential.
           *
           * Every `/api` route takes `Authorization: Bearer hh_…`, and the spec said nothing
           * about it: openapi-typescript, openapi-generator and Scalar's "try it" all produced
           * clients with no auth hook, and the README tells an agent this document *is* the API
           * it may call. Two lines here are the difference between generating a client and
           * hand-writing one.
           */

          components: {
            securitySchemes: {
              bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                description: 'An API token from `home-hosted set-token --generate`. A cookie session works too, but is not part of this scheme.',
              },
            },
          },
          security: [{ bearerAuth: [] }],
          servers: [{ url: '/', description: 'This panel' }],
        },
      }),
    )
    .get(
      `${PREFIX}/ui`,
      // A page that works with no internet, with the CDN browser as optional enhancement — see
      // `src/openapi-reference.ts` for why `Scalar()` alone was blank on the box this ships to.
      c => c.html(openApiReferencePage(`${PREFIX}/spec.json`)),
    )
}
