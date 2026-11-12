import process from 'node:process'
import { defineCommand } from 'citty'
import { runDown } from '#src/cli/down'
import { fail, invocation, paint } from '#src/cli/io'
import { runServerAction } from '#src/cli/server'
import { checkedUpFlags, exposureRefusal, runUp, upArgs } from '#src/cli/up'

/**
 * `restart` restarts the panel (`down`, then `up`) — or, given a server id, just that entry.
 *
 * The id is optional on purpose. `restart` already meant the panel, and it still does when
 * called the way it always was; adding a positional would have been a hard error before this
 * ("Unexpected argument 'web'"), so nothing existing changes meaning. The per-server case is
 * what the UI's Restart button has always done and the shell could not.
 */

/**
 * The `up` flags that mean nothing to `restart <id>`, as citty parses them.
 *
 * The bare form forwards all of them — `restart --print-config` is a real, tested use. The id form
 * asks the panel to restart one entry over `/_hh` and never runs `down` or `up`, so a panel-level
 * flag has nothing to act on: `restart web --port 5000` used to report "restarted web" having
 * changed no port. `upArgs` declares no defaults, so a flag that was not given is `undefined`.
 */
const PANEL_ONLY_FLAGS = [
  ['port', '--port'],
  ['host', '--host'],
  ['autostart', '--no-autostart'],
  ['open', '--open'],
  ['foreground', '--foreground'],
  ['printConfig', '--print-config'],
] as const

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
        const panelFlag = PANEL_ONLY_FLAGS.find(([key]) => args[key] !== undefined)
        if (panelFlag !== undefined)
          fail(`restart <id> restarts one server and takes no panel option — drop ${panelFlag[1]}, or use it on a bare \`restart\``)
        const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
        await runServerAction('restart', id, workspace)
        return
      }

      // The panel's own restart takes no `--workspace`: it is not a per-server idea.
      if (args.workspace !== undefined)
        fail(`restart --workspace needs a server id — \`${invocation()} restart <id> --workspace <id>\``)

      // `--with-persistent` restarts them, it does not merely stop them. `up` would *reattach*
      // to a nanny left alive, so stopping them first is what makes this a restart at all —
      // and a stopped entry is only started back by `up`'s autostart pass, which an entry with
      // `autostart: false` is not in. Those are therefore started back explicitly.
      //
      // Every `up` flag is checked before anything is stopped: `restart --port abc` used to take the
      // panel down and only then refuse the port, leaving nothing running.
      const flags = await checkedUpFlags(args)
      // The bind is checked too: `restart --host lan` on the first-run password used to stop the
      // panel and every non-persistent server, then have the new panel refuse to start.
      const exposure = await exposureRefusal(flags.host)
      if (exposure !== null)
        fail(`refusing to restart: ${exposure} — nothing was stopped`)
      const down = await runDown({ withPersistent: args.withPersistent === true })
      // `down` has already said why; going on to `up` would start a second panel over a live one.
      if (!down.ok)
        process.exit(1)
      await runUp(flags, entry)
      if (down.stoppedPersistent.length > 0)
        await startPersistentBack(down.stoppedPersistent)
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
