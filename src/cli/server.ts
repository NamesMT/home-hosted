import process from 'node:process'
import { defineCommand } from 'citty'
import { fail, green } from '#src/cli/io'

/**
 * `start`/`stop`/`restart` for one supervised server.
 *
 * The supervisor lives inside the daemon, so a single server cannot be started or
 * stopped without it: these drive the running panel over its local control channel
 * (the same token `down` uses), which needs no session and no API token.
 *
 * `restart` shares the name with the panel's own restart, which is why the id is optional:
 * bare `restart` stays "down, then up", and `restart <id>` is one entry — the same thing the
 * UI's per-server Restart button does, which the shell could not.
 */

export type ServerAction = 'start' | 'stop' | 'restart'

interface ActionBody {
  ok?: boolean
  error?: string
  message?: string
}

export async function runServerAction(action: ServerAction, id: string, workspace?: string): Promise<void> {
  const { clearRuntime, isProcessAlive, readRuntime, requestControl } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null || !isProcessAlive(runtime.pid)) {
    if (runtime !== null)
      clearRuntime()
    fail('home-hosted is not running — start it with `home-hosted up`')
  }

  const query = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
  const answer = await requestControl(runtime, `/_hh/servers/${encodeURIComponent(id)}/${action}${query}`)
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)

  const body = (answer.body ?? {}) as ActionBody
  if (body.ok !== true) {
    const reason = body.error ?? body.message
    if (reason !== undefined)
      fail(reason)
    // A panel from before this command answers a bare 404: say which release is running
    // rather than leaving a puzzled person staring at a status code.
    if (answer.status === 404)
      fail(`the panel on ${runtime.url} is home-hosted ${runtime.version}, which does not know this command — restart it on this release`)
    fail(`the panel answered ${answer.status}`)
  }

  // The past tense is the verb: `restart` says "restarted", not "stopped".
  const verb = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'
  process.stdout.write(`${green(verb)} ${workspace === undefined ? '' : `${workspace}/`}${id}\n`)
}

/** One line of help per action, since `restart` has two meanings to keep apart. */
const DESCRIPTION: Record<ServerAction, string> = {
  start: 'start one server (the panel keeps running)',
  stop: 'stop one server (the panel keeps running)',
  restart: 'restart one server (the panel keeps running)',
}

function serverCommand(action: ServerAction) {
  return defineCommand({
    meta: {
      name: action,
      description: DESCRIPTION[action],
    },
    args: {
      // `required: false` keeps citty's own refusal out of the way: the message below
      // names the id and where to find it.
      id: { type: 'positional', required: false, description: 'the server id from the workspace\'s servers.config.json' },
      workspace: { type: 'string', alias: 'w', description: 'the workspace to act in (default: the panel\'s default workspace)' },
    },
    run: async ({ args }) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length === 0)
        fail(`${action} needs a server id — see \`home-hosted status\` or the workspace's servers.config.json`)
      const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
      await runServerAction(action, id, workspace)
    },
  })
}

export const startCommand = serverCommand('start')
export const stopCommand = serverCommand('stop')
// `restart` is deliberately absent: bare `restart` means the *panel*, and `restart <id>` is handled by
// `cli/restart.ts` through the same `runServerAction`. A `restartServerCommand` used to be exported
// here — never wired into the command surface, so it read as an entry point nothing could reach.
