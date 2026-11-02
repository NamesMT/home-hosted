import process from 'node:process'
import { defineCommand } from 'citty'
import { green } from '#src/cli/io'
import { hhDir as dataRoot } from '#src/helpers/paths'
import { UiService } from '#src/services/ui'

/** `ui-revert` drops a user-installed UI so the stock panel serves again. */

export async function runUiRevert(): Promise<void> {
  const ui = new UiService({ dataRoot })

  if (!ui.custom) {
    process.stdout.write('no custom UI is installed — the stock panel is already in use\n')
    return
  }
  ui.revert()
  process.stdout.write(`${green('custom UI removed')} — the stock panel is back; refresh the browser\n`)
}

export const uiRevertCommand = defineCommand({
  meta: { name: 'ui-revert' },
  // Declared **empty** on purpose. `rejectUnknownFlags` refuses every flag and bare word for a
  // command whose definition is empty, and that is the whole point here: this command used to
  // declare nothing at all, which reads as "parses my own argv" — and it parses nothing. So
  // `ui-revert --dry-run` printed "custom UI removed" and deleted the installed UI, exiting 0,
  // because nothing ever looked at the flag. A command that takes no options now says so.
  args: {},
  run: async () => {
    await runUiRevert()
  },
})
