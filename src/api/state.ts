import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import type { MetaView } from '#src/shared/contracts'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { appVersion } from '#src/helpers/version'
import { workspaceLimit } from '#src/helpers/workspace'
import { requestIdentity } from '#src/middleware/auth'
import { narrowStateFor } from '#src/services/state'
import { appStateSchema, metaViewSchema, sseEventNames } from '#src/shared/contracts'
import { ERROR_CODES } from '#src/shared/error-codes'
import { lazy } from '#src/shared/lazy'
import { credentialOf, credentialRefusals } from '#src/shared/meta'

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

/**
 * The SSE `event:` names, derived per request rather than once at import.
 *
 * Called inside the handler on purpose: `sseEventNames()` reads four `lazy()` schemas' JSON Schema, which
 * materialises them. Hoisting it to a module constant moved that cost from "when asked" to "when loaded"
 * and `lazy.test.ts` counted 79 built schemas — the same failure the literal was replacing.
 */

/**
 * `GET /api/meta`: what this panel is, who is asking, and what that credential may not do.
 *
 * Derived from live state on every request rather than cached: `features` reports what is switched on
 * now*, so a settings save is visible on the next call, and `credential` describes the request in
 * hand rather than the panel. Only `version`/`apiVersion` are constants.
 */
function metaOf(deps: AppDeps, c: Context): MetaView {
  const identity = requestIdentity(c, deps.auth)
  const credential = credentialOf(identity, deps.auth.apiTokenHint)
  return {
    version: appVersion(),
    apiVersion: 1,
    credential,
    actor: credential.kind === 'token' ? 'agent' : 'user',
    refused: credentialRefusals(credential.kind),
    features: {
      proxy: deps.panel.settings.proxy.enabled,
      // Panel-wide "in use anywhere": the service is per workspace, and that `enabled` is what starts
      // a pass, so any one enabled workspace makes the feature on.
      ddns: deps.panel.workspaces().some(workspace => workspace.store.ddns.enabled),
      // Configured, not merely supported: the bridge does nothing until `host.tempCommand` names one.
      temperature: deps.panel.settings.host.tempCommand.trim().length > 0,
    },
    /** The catalogue's own keys, so a client is never handed a code the panel does not know. */
    errorCodes: Object.keys(ERROR_CODES),
    events: sseEventNames(),
  }
}

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
      (c) => {
        /*
         * A workspace-limited credential gets only its own workspaces.
         *
         * The limit is enforced by the scope guard on every route that **names** a workspace, and
         * this one names none — so "nothing to check it against" was answered by sending every
         * workspace's full subtree, which is the same `ServerView` `GET /api/servers` refuses that
         * account. `src/services/state.ts` carries the measurement; `narrowStateFor` is the one
         * definition, shared with `GET /api/workspaces`.
         */
        return c.json(narrowStateFor(deps.panel.getState(), workspaceLimit(c)))
      },
    )

    .get(
      '/meta',
      describeRoute({
        tags: ['panel'],
        summary: 'What this panel is, which credential answered, and what it may not do',
        description: 'Answers in one request what a client otherwise probes for one by one: the release and API version, the credential in use, the actions that credential is refused, which optional subsystems are switched on, every error code, and the SSE event names.',
        responses: {
          200: {
            description: 'The panel and this credential',
            /**
             * A getter, because `jsonBody` **builds** the schema it is handed: a module-level call
             * would undo `lazy` and put the cost of every contract on every import.
             */
            get content() {
              return jsonBody(metaViewSchema)
            },
          },
        },
      }),
      validate('query', stateQuery),
      c => c.json(metaOf(deps, c)),
    )
}
