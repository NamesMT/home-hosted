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

/**
 * The `up` flags that mean nothing to `restart <id>`, with every spelling citty accepts for each.
 *
 * The bare form forwards all of them — `restart --print-config` is a real, tested use, and it is how
 * the panel path is observable without detaching a daemon. The id form is a different command: it
 * asks the panel to restart one entry over `/_hh` and never runs `down` or `up`, so a panel-level
 * flag has nothing to act on.
 *
 * `--with-persistent` already had this guard. These six did not, so they were parsed and dropped in
 * the same handler: `restart web --port 5000` reported "restarted web" having changed no port, and
 * `restart web --print-config` restarted a live server while reading as "show me the config".
 */
const PANEL_ONLY_FLAGS: ReadonlyArray<{ name: string, spellings: readonly string[] }> = [
  { name: '--port', spellings: ['--port', '-p'] },
  { name: '--host', spellings: ['--host'] },
  { name: '--no-autostart', spellings: ['--no-autostart', '--autostart'] },
  { name: '--open', spellings: ['--open'] },
  { name: '--foreground', spellings: ['--foreground'] },
  { name: '--print-config', spellings: ['--print-config'] },
]

/**
 * Whether argv names one of these flags, in either the `--flag value` or `--flag=value` form.
 *
 * Read from `rawArgs` rather than the parsed args: citty fills a default in for the boolean flags
 * (`autostart` defaults to true), so the parsed object cannot tell "the caller said `--no-autostart`"
 * from "the caller said nothing".
 */
function mentions(rawArgs: string[], spellings: readonly string[]): boolean {
  return rawArgs.some((token) => {
    if (!token.startsWith('-'))
      return false
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    return spellings.includes(name)
  })
}
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
    run: async ({ args, rawArgs }) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''

      if (id.length > 0) {
        // One entry, so the panel stays up. A bare `restart` would have taken the whole
        // panel — and every other server — down with it.
        if (args.withPersistent === true)
          fail('restart <id> restarts one server — drop --with-persistent, or use it on a bare `restart`')
        // `restart <id>` asks the panel to restart one entry through `/_hh`; it never runs `down`
        // or `up`, so none of `up`'s flags can be honoured here. They used to be parsed and
        // dropped: `restart web --print-config` restarted a live server while reading as "show me
        // the config", and `restart web --port 5000` reported success having changed no port.
        // Refused by name, the way `--with-persistent` above already was.
        const panelFlag = PANEL_ONLY_FLAGS.find(flag => mentions(rawArgs, flag.spellings))
        if (panelFlag !== undefined)
          fail(`restart <id> restarts one server and takes no panel option — drop ${panelFlag.name}, or use it on a bare \`restart\``)
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
