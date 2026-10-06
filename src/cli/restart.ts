import { defineCommand } from 'citty'
import { runDown } from '#src/cli/down'
import { fail } from '#src/cli/io'
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
        const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
        await runServerAction('restart', id, workspace)
        return
      }

      // The panel's own restart takes no `--workspace`: it is not a per-server idea.
      if (args.workspace !== undefined)
        fail('restart --workspace needs a server id — `home-hosted restart <id> --workspace <id>`')

      await runDown()
      await runUp(toUpFlags(args), entry)
    },
  })
}
