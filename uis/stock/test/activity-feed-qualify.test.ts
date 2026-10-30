import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'
import { openingTags } from '../../../test/helpers/template-render'

/**
 * A feed that spans workspaces has to say which one each row is in.
 *
 * A server id and its label are only unique inside a workspace, so `config.label ?? server.id`
 * is not an identity. Measured in Chromium against a real two-workspace panel, the Global
 * Overview's Recent activity rendered two rows reading exactly `crashy` — one per workspace,
 * both crashed — and nothing on screen said which entry each link opened. The card grid and the
 * "needs a look" banner beside it already qualify (`Default/crashy`, `Second Box/crashy`), so
 * the page contradicted itself one panel apart.
 *
 * The rule is a template scan rather than a mount for the reason the sibling scans give: a mount
 * pins the one call site written today, and the next feed added to a cross-workspace page is
 * exactly the author this has to catch.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

function vueFiles(): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      found.push(path.join(entry.parentPath, entry.name))
  }
  return found.sort()
}

/**
 * Each opening `<ActivityFeed …>` tag, comments stripped.
 *
 * Self-closing and paired are one call site: the old matcher read only `/>`, so a `qualify` dropped
 * on `<ActivityFeed …></ActivityFeed>` was no call site at all.
 */
function feedTags(source: string): string[] {
  return openingTags(templateRegion(source), 'ActivityFeed')
}

/**
 * A page is cross-workspace when it reads the all-workspaces list. `control.allServers` is that
 * list in the stock UI, and it is what the Global Overview feeds this component — the per-workspace
 * pages pass `servers` from their own selection instead.
 */
function spansWorkspaces(source: string): boolean {
  return /control\.allServers/.test(source)
}

describe('a cross-workspace activity feed names the workspace', () => {
  it('finds the call sites, so a broken matcher cannot pass for free', () => {
    const total = vueFiles().reduce((sum, file) => sum + feedTags(fs.readFileSync(file, 'utf8')).length, 0)
    expect(total).toBeGreaterThanOrEqual(3)
  })

  it('finds the cross-workspace page, so the rule cannot hold vacuously', () => {
    const spanning = vueFiles().filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return feedTags(source).length > 0 && spansWorkspaces(source)
    })
    expect(spanning.map(file => path.basename(file))).toContain('GlobalOverviewView.vue')
  })

  it('passes `qualify` on every feed a cross-workspace page renders', () => {
    const offenders: string[] = []
    for (const file of vueFiles()) {
      const source = fs.readFileSync(file, 'utf8')
      if (!spansWorkspaces(source))
        continue
      for (const tag of feedTags(source)) {
        // `qualify` (shorthand) or `:qualify="…"` (bound); either states the intent.
        if (!/(?<![\w.-]):?qualify\b/.test(tag))
          offenders.push(path.basename(file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('leaves a single-workspace feed alone, where the prefix is noise', () => {
    const scoped = vueFiles().filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return feedTags(source).length > 0 && !spansWorkspaces(source)
    })
    // The Overview and the detail page both render the feed within one workspace.
    expect(scoped.length).toBeGreaterThanOrEqual(2)
    for (const file of scoped) {
      for (const tag of feedTags(fs.readFileSync(file, 'utf8')))
        expect(tag, `${path.basename(file)} needs no workspace prefix`).not.toMatch(/(?<![\w.-]):?qualify\b/)
    }
  })
})
