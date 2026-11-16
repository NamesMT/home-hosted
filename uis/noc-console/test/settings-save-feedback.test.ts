import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../test/helpers/strip-comments'

/**
 * A settings save must report its outcome where the person is looking.
 *
 * Both settings pages rendered the outcome in a `.settings-note` that is the **last** child of the
 * page's scrolling body. Measured in Chromium at 1280×900 against the running dev panel, after
 * pressing Save with nothing changed:
 *
 * | page | Save button top | note top | distance | in viewport |
 * | --- | --- | --- | --- | --- |
 * | `/w/default/settings` | 52 px | 1639 px | **1561 px** | no |
 * | `/global/settings` | 52 px | 2347 px | **2269 px** | no |
 *
 * The note only became visible after scrolling the `.view` scroller to its end (`scrollTop` 790 and
 * 1498 respectively). So pressing Save looked like nothing happened — on the two pages where a
 * person is most likely to press it.
 *
 * The console already has the right surface: a `position: fixed` toast (`App.vue`) fed by
 * `flash()`, which the server config editor uses for the very same "nothing changed" string. These
 * pages simply never called it.
 *
 * A source scan rather than a mount: the defect is the *absence of a call* on a 900-line view whose
 * whole composable surface would have to be faked, and a fake that answered "nothing changed" would
 * pass whatever the page did with the answer.
 */
const here = fileURLToPath(new URL('..', import.meta.url))
const view = (name: string): string => stripComments(fs.readFileSync(path.join(here, 'src', 'views', name), 'utf8'))

/** The body of `saveSettings`, so an assertion cannot be satisfied by an unrelated call elsewhere. */
function saveBody(source: string): string {
  const start = source.indexOf('async function saveSettings')
  expect(start, 'saveSettings must exist for this guard to mean anything').toBeGreaterThan(-1)
  // The function ends at the first line that closes it at column 0.
  const rest = source.slice(start)
  const end = rest.indexOf('\n}\n')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the settings pages report a save beside the button, not at the end of the scroll', () => {
  for (const name of ['SettingsView.vue', 'GlobalSettingsView.vue']) {
    it(`${name} flashes the outcome through the fixed toast`, () => {
      const source = view(name)
      expect(source, `${name} must import flash`).toMatch(/import \{[^}]*\bflash\b[^}]*\} from '@\/composables\/useUi'/)

      const body = saveBody(source)
      expect(body, `${name} must flash "nothing changed"`).toContain(`flash('nothing changed')`)
      // And a real save, so the control gives feedback for the common case too.
      expect(body, `${name} must flash a completed save`).toMatch(/flash\([^)]*saved[^)]*\)/)
    })
  }

  it('keeps the inline note as the record, not as the only signal', () => {
    // Removing the note would lose the text once the toast expires (4.2 s); the fix is to add the
    // toast beside it, not to move the message.
    for (const name of ['SettingsView.vue', 'GlobalSettingsView.vue']) {
      const source = view(name)
      expect(source, `${name} keeps its settings-note`).toContain('settings-note')
    }
  })
})
