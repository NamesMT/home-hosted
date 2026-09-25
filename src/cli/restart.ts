import { defineCommand } from 'citty'
import { runDown } from '#src/cli/down'
import { runUp, toUpFlags, upArgs } from '#src/cli/up'

/** `restart` is `down`, then `up` with exactly the flags it was given. */

export function restartCommand(entry: string) {
  return defineCommand({
    meta: { name: 'restart', description: 'down, then up' },
    args: upArgs,
    run: async ({ args }) => {
      await runDown()
      await runUp(toUpFlags(args), entry)
    },
  })
}
