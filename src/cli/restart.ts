import process from 'node:process'
import { defineCommand } from 'citty'
import { runDown } from '#src/cli/down'
import { fail, paint } from '#src/cli/io'
import { runServerAction } from '#src/cli/server'
import { runUp, toUpFlags, upArgs } from '#src/cli/up'

/**
 * `restart` restarts the panel (`down`, then `up`) — or, given a server id, just that entry.
 *
 * The id is optional on purpose. `restart` already meant the panel, and it still does when
 * called the way it always was; adding a positional would have been a hard error before this
 * ("Unexpected argument 'web'"), so nothing existing changes meaning. The per-server case is
 * what the UI's Restart button has always done and the shell could not.
 */
export function restartCommand(entry: string) {
  return defineCommand({
    meta: { name: 'restart' },
    args: {
      ...upArgs,
      // `down`'s own flag, so the two commands cannot drift about what it means. Declared
      // here as well because citty reads one command's definitions, not two.
      withPersistent: { type: 'boolean', description: 'stop the persistent entries too, instead of leaving them running' },
      // Declared here rather than in `server.ts` because only `restart` takes it bare: for
      // `start`/`stop` the id is required, and citty's refusal is replaced by our own message.
      id: { type: 'positional', required: false, description: 'restart just this server instead of the panel' },
      workspace: { type: 'string', alias: 'w', description: 'the workspace to act in (default: the panel\'s default workspace)' },
    },
    run: async ({ args }) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''

      if (id.length > 0) {
        // One entry, so the panel stays up. A bare `restart` would have taken the whole
        // panel — and every other server — down with it.
        if (args.withPersistent === true)
          fail('restart <id> restarts one server — drop --with-persistent, or use it on a bare `restart`')
        const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
        await runServerAction('restart', id, workspace)
        return
      }

      // The panel's own restart takes no `--workspace`: it is not a per-server idea.
      if (args.workspace !== undefined)
        fail('restart --workspace needs a server id — `home-hosted restart <id> --workspace <id>`')

      // `--with-persistent` restarts them, it does not merely stop them. `up` would *reattach*
      // to a nanny left alive, so stopping them first is what makes this a restart at all —
      // and a stopped entry is only started back by `up`'s autostart pass, which an entry with
      // `autostart: false` is not in. Those are therefore started back explicitly.
      const stopped = (await runDown({ withPersistent: args.withPersistent === true })).stoppedPersistent
      await runUp(toUpFlags(args), entry)
      if (stopped.length > 0)
        await startPersistentBack(stopped)
    },
  })
}

/**
 * Starts the entries this restart stopped, through the panel that just came back.
 *
 * Only the ones `up` did not already start: its autostart pass runs asynchronously and a second
 * start of a running entry is a plain `{ ok: true }`, so re-asking is harmless — but the
 * entries with `autostart: false`, the reason this exists, would never come back otherwise.
 */
async function startPersistentBack(stopped: Array<{ workspaceId: string, serverId: string }>): Promise<void> {
  const { readRuntime, requestControl } = await import('#src/helpers/daemon')
  const runtime = readRuntime()
  if (runtime === null)
    return

  for (const { workspaceId, serverId } of stopped) {
    const workspace = `?workspace=${encodeURIComponent(workspaceId)}`
    const answer = await requestControl(runtime, `/_hh/servers/${encodeURIComponent(serverId)}/start${workspace}`)
    const body = (answer?.body ?? {}) as { ok?: boolean, error?: string }
    if (body.ok !== true)
      process.stderr.write(`${paint('31', 'error')} ${workspaceId}/${serverId} did not come back: ${body.error ?? `the panel answered ${answer?.status}`}\n`)
  }
}
