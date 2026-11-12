/* eslint-disable no-template-curly-in-string -- the plant is source text, not a template: the
   `${…}` in it is the shape under test. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * noc-console shows the same "restart to apply" state stock does.
 *
 * `PUT`/`PATCH /api/servers/:id` writes config only, and the server view's optional `restartRequired`
 * is the panel saying the running process predates a change to a field a restart re-reads. The whole
 * point of the badge is that a person who changed the program and read "saved" is not left believing
 * the change is live — so a UI that never renders the field is telling half the story, which is the
 * defect this release exists to fix.
 *
 * A source scan rather than a mount: noc-console's config and detail views both pull a live control
 * plane, and the assertion that matters is that **both surfaces read the field**. The rendered half
 * is `uis/stock/test/restart-required-badge.test.ts`.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

describe('noc-console and a config change that needs a restart', () => {
  it.each([
    ['config view', 'src/views/ServerConfigView.vue'],
    ['detail panel', 'src/components/ServerDetail.vue'],
  ])('says so on the %s', (_name, file) => {
    const source = read(file)
    expect(source, `${file} must read the server view's restartRequired`).toContain('restartRequired')
    expect(source, `${file} must render the wording`).toContain('restart to apply')
  })

  /** The save toast is where a person learns it first, so it says which state they are in. */
  it('tells the save apart from the restart', () => {
    const source = read('src/views/ServerConfigView.vue')
    expect(source, 'a save that needs a restart says so').toContain('restart to apply')
    // And a plain save keeps its old wording, rather than every save nagging.
    expect(source).toContain('`saved ${props.id}`')
  })
})
