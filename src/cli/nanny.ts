import { defineCommand } from 'citty'
import { NANNY_COMMAND } from '#src/helpers/runtime'

/**
 * The hidden command that runs one persistent entry. The panel spawns it from the
 * argv in `helpers/runtime.ts`; nothing a person types reaches it, so it stays out of
 * the curated help and keeps citty's own for `--help`.
 */
export const nannyCommand = defineCommand({
  meta: { name: NANNY_COMMAND, description: 'internal: run one persistent entry' },
  args: {
    id: { type: 'string', required: true },
    spec: { type: 'string', required: true },
    state: { type: 'string', required: true },
  },
  run: async ({ args }) => {
    const { takeNannySpec } = await import('#src/providers/nanny')
    const { runNanny } = await import('#src/services/nanny')

    const spec = takeNannySpec(args.spec)
    if (spec.serverId !== args.id)
      throw new Error(`this spec runs "${spec.serverId}", not "${args.id}"`)

    await runNanny(spec, args.state)
  },
})
