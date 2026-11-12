import type { WorkspaceStore } from '#src/config/store'
import type { ServerConfig } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { ConfigError } from '#src/config/store'
import { configFailure } from '#src/helpers/error'

/**
 * Adds one entry to a workspace, the one way every caller does it: `POST /api/servers`,
 * `POST /_hh/servers` and an offline `home-hosted add`.
 *
 * A duplicate id is a conflict with what exists (`409 SERVER_EXISTS`), not a bad body — it used to
 * answer `400 INVALID_SERVER`, the same code as a schema failure, so a client could not tell "pick
 * another id" from "fix the entry". Anything the store refuses is still `INVALID_SERVER`.
 */
export function addServerEntry(store: WorkspaceStore, input: Record<string, unknown>): ServerConfig {
  const id = String(input.id)
  if (store.getServer(id) !== undefined)
    throw new DetailedError(`server "${id}" already exists`, { statusCode: 409, code: 'SERVER_EXISTS' })
  try {
    return store.addServer(input)
  }
  catch (error) {
    if (error instanceof ConfigError)
      throw configFailure(error, 'INVALID_SERVER')
    throw error
  }
}
