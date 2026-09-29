import process from 'node:process'
import { defineCommand } from 'citty'
import { fail, green } from '#src/cli/io'

/**
 * `start`/`stop` for one supervised server.
 *
 * The supervisor lives inside the daemon, so a single server cannot be started or
 * stopped without it: these drive the running panel over its local control channel
 * (the same token `down` uses), which needs no session and no API token.
 */

export type ServerAction = 'start' | 'stop'

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

  process.stdout.write(`${green(action === 'start' ? 'started' : 'stopped')} ${workspace === undefined ? '' : `${workspace}/`}${id}\n`)
}

function serverCommand(action: ServerAction) {
  return defineCommand({
    meta: {
      name: action,
      description: action === 'start' ? 'start one server (the panel keeps running)' : 'stop one server (the panel keeps running)',
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
