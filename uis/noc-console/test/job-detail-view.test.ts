import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A job's detail box does not offer settings the panel refuses to save.
 *
 * A job is run-to-completion, so the schema rejects `health`, `restart`, `stop` and `port` on one.
 * Rendering them as "off" described a decision nobody made and invited a person to switch one on,
 * which the save would then refuse. Stock already branches on `kind` for its action row; this pins
 * the noc-console half, which the review flagged as needing a rendered check.
 *
 * A source scan rather than a mount: this view pulls a live control plane, which the UI test
 * environment cannot stand up. The behaviour it guards is a `v-if` on `kind`, which is what a scan can
 * see and a typecheck cannot.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const source = fs.readFileSync(path.join(root, 'src/components/ServerDetail.vue'), 'utf8')

describe('the job detail box', () => {
  it('omits the service-only rows on a job', () => {
    // Each of the three rows is guarded, and the guard is the job check.
    for (const key of ['health', 'restart', 'stop'])
      expect(source, `the ${key} row must be hidden on a job`).toMatch(new RegExp(`v-if="!isJob"[^>]*>\\s*<span class="detailbox__k">${key}`))
  })

  it('says what a job is instead', () => {
    expect(source).toMatch(/v-if="isJob"/)
    expect(source).toContain('run to completion')
  })

  it('reads `kind` from the config, defaulting to a service', () => {
    expect(source).toContain('props.server.config.kind === \'job\'')
  })
})
