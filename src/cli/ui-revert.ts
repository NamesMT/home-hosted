import process from 'node:process'
import { defineCommand } from 'citty'
import { green } from '#src/cli/io'
import { dataRoot } from '#src/helpers/paths'
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
  meta: { name: 'ui-revert', description: 'go back to the stock control panel UI' },
  run: async () => {
    await runUiRevert()
  },
})
