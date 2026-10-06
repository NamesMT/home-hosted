import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every path helper in `helpers/paths.ts` must be reachable.
 *
 * Six used to be exported and read by nothing: `globalSettingsSchemaPath`, `workspacesSchemaPath`,
 * `defaultBackupsDirName`, `workspaceSettingsSchemaPath` and `workspaceServersSchemaPath` were all
 * added once and never called — each caller built the same string inline instead (`settings.ts` does
 * `path.join(path.dirname(this.file), 'settings.schema.json')`). They read as the place to change the
 * layout while changing them did nothing, which is worse than absent: `defaultBackupsDirName` looked
 * like the definition of `.backups` while two real sites spelled `.backups` themselves.
 *
 * Deliberately narrow, on one file. A repo-wide scan for unused exports produced ~230 candidates of
 * which nearly all were false positives (schemas built inside their own module, CLI entries loaded
 * through dynamic `import()`, helpers used within their own file); a guard that noisy gets disabled.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** Every `.ts`/`.vue` under the repo, minus build output and dependencies. */
function searchableFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name))
        continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())
        walk(full)
      else if (/\.(?:ts|vue)$/.test(entry.name))
        out.push(full)
    }
  }
  walk(root)
  return out
}

describe('path helpers', () => {
  it('exports nothing that no caller uses', () => {
    const files = searchableFiles()
    // Anti-vacuity: the walk must actually see the tree.
    expect(files.length).toBeGreaterThan(60)

    // Comments are stripped first: this file's own prose names one of the removed helpers, which
    // counted as a use and would make the guard pass on exactly what it exists to catch.
    const deComment = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
    const bodies = files.map(file => ({ rel: path.relative(root, file).replaceAll('\\', '/'), text: deComment(fs.readFileSync(file, 'utf8')) }))

    const source = deComment(fs.readFileSync(path.join(root, 'src/helpers/paths.ts'), 'utf8'))
    const exported = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]!)
    // The file is the layout table; an empty list would make this pass for the wrong reason.
    expect(exported.length, 'expected the layout exports').toBeGreaterThan(10)

    const orphans = exported.filter((name) => {
      const elsewhere = bodies
        .filter(file => file.rel !== 'src/helpers/paths.ts')
        .reduce((total, file) => total + [...file.text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length, 0)
      // One occurrence inside the file is the declaration itself; a second means it uses itself.
      const inside = [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length
      return elsewhere === 0 && inside === 1
    })

    expect(orphans, 'an unreachable path helper reads as the layout table and changes nothing').toEqual([])
  })
})
