import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * A secret's **name** and its **value box** sit together, below the other environment fields.
 *
 * Reported from the running UI: "we need to set a secret in two places, the Secret environment names
 * and the block below, which is very far away at the bottom of the page". The names textarea was
 * above `args`, the values panel was the last thing on the page, and the two agreed only after a save.
 *
 * The rule, which a refactor can break silently because nothing renders wrong:
 *
 *  1. `SecretEnvBlock` lives in the **same** `FieldGroup` as the env fields — not after it.
 *  2. The names field comes **after** `dataEnvs`, so the three environment fields read in one run.
 *  3. The block comes **after** the names field, so the boxes are under the names that declare them.
 *
 * A source scan, because the defect is one of ordering across two template regions — a mounted
 * assertion would pass with the block moved to the bottom of the page again.
 *
 * **Only `stock` is scanned here, and that is not the whole rule.** `noc-console` renders its form
 * through `FORM_LAYOUT` (`@/lib/serverForm`), so its markup has no `form.secretEnv` to find and its
 * ordering is data, not template text. Pinning the same rule there by naming a UI's spelling would
 * be pinning the wrong thing: `uis/noc-console/test/server-form-fields.test.ts` mounts the form and
 * asserts the block is drawn *immediately after its anchor field, in that field's own grid*. That
 * is the rule; a scan that listed noc-console and found nothing would have looked like coverage in
 * this commit's message while the noc-console block sat 1897 px from the names it explains.
 */
const root = process.cwd()

describe.each([
  ['stock', 'uis/stock/src/components/server/ServerConfigEditor.vue'],
])('%s puts the secret names and their values together', (_ui, file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8')

  it('declares the names below Data envs', () => {
    const dataEnvs = source.indexOf('v-model="form.dataEnvs"')
    const names = source.indexOf('v-model="form.secretEnv"')
    expect(dataEnvs, 'the Data envs field must exist').toBeGreaterThan(-1)
    expect(names, 'the secret names field must exist').toBeGreaterThan(-1)
    expect(names, 'the names field belongs after Data envs').toBeGreaterThan(dataEnvs)
  })

  it('puts the value boxes directly after the names, in the same group', () => {
    const names = source.indexOf('v-model="form.secretEnv"')
    const block = source.indexOf('<SecretEnvBlock')
    expect(block, 'the value block must be rendered').toBeGreaterThan(-1)
    expect(block, 'the boxes belong under the names that declare them').toBeGreaterThan(names)

    // Both inside one <FieldGroup …>…</FieldGroup>: the block is not a sibling at the page's end.
    const groupEnd = source.indexOf('</FieldGroup>', names)
    expect(block, 'the block must be inside the env group, not after it').toBeLessThan(groupEnd)
  })

  it('feeds the block the live draft, not the saved config', () => {
    // The reactivity half: `:config="props.config"` was the bug — it only changes after a save.
    expect(source).toContain(':declared="draftSecretNames"')
    expect(source).not.toMatch(/<SecretEnvBlock[\s\S]{0,400}:config="/)
  })
})
