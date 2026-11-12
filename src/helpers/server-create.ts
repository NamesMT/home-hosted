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

/**
 * What is wrong with an entry that will only show up when it fails to start.
 *
 * `command` is a **program**, spawned with no shell, so `"node server.js"` asks for a program of that
 * name. The entry was accepted with `201` and failed at spawn — then retried `restart.maxRetries`
 * times with the same `ENOENT` before the card said "gave up after 3 retries", having told the person
 * it was created. A warning cannot refuse the entry (it may be valid on the machine it targets, and
 * the panel does not execute anything to find out), so it is reported beside the success.
 *
 * The advice names the **config keys** (`command`, `args`), which is what a person editing
 * `servers.config.json` or an API body can act on — the UI labels `Command`/`Arguments` appear
 * nowhere there.
 *
 * Deliberately conservative, because a warning that fires on a legitimate entry trains people to
 * ignore it. A `command` **whose first word is a path** (`C:\Program Files\app.exe`, `/opt/my
 * app/server`) is one program whose name holds a space, not a command line: the split is only
 * claimed when the part before the first space is a bare word with no separator in it, which is
 * what a pasted command line always looks like (`node`, `python`, `npm`).
 */
export function serverWarnings(entry: Pick<ServerConfig, 'command' | 'args'>): string[] {
  const command = entry.command.trim()
  const first = command.split(/\s+/)[0] ?? ''
  // One word, or a path that legitimately holds a space: nothing to warn about.
  if (first === command || first.includes('/') || first.includes('\\'))
    return []
  return [`\`command\` holds a whole command line ("${command}") — an entry is spawned without a shell, so this asks for a program with exactly that name. Put the program in \`command\` and each argument in \`args\`.`]
}
