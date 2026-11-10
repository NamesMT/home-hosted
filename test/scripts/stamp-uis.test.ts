import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The pre-commit guard that keeps a UI's `ui.json` in step with what it ships.
 *
 * It reads the **index**, so every case here stages a real change in a throwaway git repository —
 * there is no seam to inject a file list through, and the filter is exactly what one of these tests
 * exists to pin. The script derives its root from its own location, so the copy lives under the
 * scratch root, beside the `uis/` tree the case builds.
 */
const repo = process.cwd()
const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

interface Case {
  /** `uis/<name>/<path>` -> contents, written and staged. */
  files?: Record<string, string>
  /** `uis/<name>/<path>` -> contents committed first, then deleted and staged as `D`. */
  deleted?: Record<string, string>
  /** `uis/<name>/public/ui.json` version per UI, written and staged. */
  versions?: Record<string, string>
  /** What `HEAD` holds for each UI's `ui.json`, committed before the staged change. */
  committed?: Record<string, string>
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/** A git root holding a copy of the real script and the staged state a case describes. */
function stage(options: Case): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-stamp-'))
  roots.push(dir)
  fs.cpSync(path.join(repo, 'scripts'), path.join(dir, 'scripts'), { recursive: true })

  // `HEAD` is what the script compares the staged `ui.json` against, so what it must hold is
  // committed before anything is staged. A UI with no committed version is one this commit adds.
  for (const [name, version] of Object.entries(options.committed ?? {}))
    write(dir, `uis/${name}/public/ui.json`, JSON.stringify({ name, version }))
  for (const [relative, contents] of Object.entries(options.deleted ?? {}))
    write(dir, relative, contents)

  git(dir, ['init', '-q'])
  if (Object.keys(options.committed ?? {}).length > 0 || Object.keys(options.deleted ?? {}).length > 0) {
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'chore: base'])
  }

  for (const [name, version] of Object.entries(options.versions ?? {}))
    write(dir, `uis/${name}/public/ui.json`, JSON.stringify({ name, version }))
  for (const [relative, contents] of Object.entries(options.files ?? {}))
    write(dir, relative, contents)
  for (const relative of Object.keys(options.deleted ?? {}))
    fs.rmSync(path.join(dir, relative), { force: true })

  git(dir, ['add', '-A'])
  return dir
}

function run(root: string): { code: number, out: string } {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'stamp-uis.mjs')], { cwd: root, encoding: 'utf8' })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('stamp-uis', () => {
  it('accepts a commit that touches no UI', () => {
    const root = stage({ files: { 'src/cli/usage.ts': '// not a UI\n' } })
    expect(run(root).code).toBe(0)
  })

  it('refuses a shipped source change with no bump', () => {
    const root = stage({
      committed: { stock: '1.0.0' },
      versions: { stock: '1.0.0' },
      files: { 'uis/stock/src/App.vue': '<template><div /></template>\n' },
    })
    const { code, out } = run(root)
    expect(code).toBe(1)
    expect(out).toContain('uis/stock/public/ui.json is still 1.0.0')
  })

  it('accepts a shipped source change with a bump, and prints the move', () => {
    const root = stage({
      committed: { stock: '1.0.0' },
      versions: { stock: '1.0.1' },
      files: { 'uis/stock/src/App.vue': '<template><div /></template>\n' },
    })
    const { code, out } = run(root)
    expect(code, out).toBe(0)
    expect(out).toContain('stock: 1.0.0 -> 1.0.1')
  })

  it('does not demand a bump for a UI\'s own test or README', () => {
    const root = stage({
      committed: { stock: '1.0.0' },
      versions: { stock: '1.0.0' },
      files: {
        'uis/stock/test/some.test.ts': 'export {}\n',
        'uis/stock/README.md': '# stock\n',
      },
    })
    expect(run(root).code).toBe(0)
  })

  /**
   * A deletion is a change to what the UI ships, and the hook could not see one.
   *
   * The filter was `ACMR`, so a file staged as `D` alone never entered the list: `343b8fd`
   * ("chore(noc-console): drop the unused typed RPC client") deleted a shipped source file with no
   * `ui.json` bump. That particular asset happened to be unreachable, so the omission was harmless
   * there* — but the rule the hook enforces is "a change to what the UI ships bumps the version",
   * and deleting an export, a component or a whole module changes the built asset whether or not
   * this instance did.
   */
  it('demands a bump for a deleted shipped file, which `ACMR` could not see', () => {
    const root = stage({
      committed: { 'noc-console': '2.0.0' },
      versions: { 'noc-console': '2.0.0' },
      deleted: { 'uis/noc-console/src/lib/rpc.ts': 'export type Rpc = unknown\n' },
    })
    const { code, out } = run(root)
    expect(code, out).toBe(1)
    expect(out).toContain('uis/noc-console/public/ui.json is still 2.0.0')
  })

  it('accepts a deletion that is bumped', () => {
    const root = stage({
      committed: { 'noc-console': '2.0.0' },
      versions: { 'noc-console': '2.0.1' },
      deleted: { 'uis/noc-console/src/lib/rpc.ts': 'export type Rpc = unknown\n' },
    })
    const { code, out } = run(root)
    expect(code, out).toBe(0)
    expect(out).toContain('noc-console: 2.0.0 -> 2.0.1')
  })

  /** Deleting a UI's test file ships nothing, by the same rule that writing one does not. */
  it('does not demand a bump for a deleted test file', () => {
    const root = stage({
      committed: { stock: '1.0.0' },
      versions: { stock: '1.0.0' },
      deleted: { 'uis/stock/test/gone.test.ts': 'export {}\n' },
    })
    expect(run(root).code).toBe(0)
  })

  it('checks every UI a commit touches, and reports each one that is unbumped', () => {
    const root = stage({
      committed: { 'stock': '1.0.0', 'noc-console': '3.1.0' },
      versions: { 'stock': '1.0.0', 'noc-console': '3.2.0' },
      files: {
        'uis/stock/src/App.vue': '<template><div /></template>\n',
        'uis/noc-console/src/App.vue': '<template><div /></template>\n',
      },
    })
    const { code, out } = run(root)
    expect(code).toBe(1)
    expect(out).toContain('uis/stock/public/ui.json is still 1.0.0')
    expect(out, 'a UI that was bumped is reported, not refused').toContain('noc-console: 3.1.0 -> 3.2.0')
    expect(out).not.toContain('uis/noc-console/public/ui.json is still')
  })
})
