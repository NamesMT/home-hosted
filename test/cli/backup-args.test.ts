import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The flag rules that guard a destructive command, checked without a panel.
 *
 * `backup create`/`restore` write over live data, so the failures worth pinning are the ones where a
 * mistyped flag would *widen* the scope rather than refuse. Both run before the CLI reaches for a
 * running panel, so a missing panel is the only reason these need a throwaway home.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-backup-args-'))

function run(args: string[]): { status: number | null, output: string } {
  const result = spawnSync(process.execPath, ['--import=tsx', path.join(root, 'src/cli.ts'), ...args, '--home', home], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HHOSTED_HOME: home, NO_COLOR: '1' },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('backup flag guards', () => {
  it('refuses an empty --include rather than widening to everything', () => {
    // The bug this pins: `--include ""` parsed to an empty list, the request then omitted it, and a
    // "restore nothing" became a full restore over live data.
    const empty = run(['backup', 'create', '--include', ''])
    expect(empty.status).toBe(1)
    expect(empty.output).toContain('--include is empty')
    expect(empty.output).toContain('--all')
  })

  it('refuses a --include made only of separators', () => {
    const commas = run(['backup', 'create', '--include', ',,,'])
    expect(commas.status).toBe(1)
    expect(commas.output).toContain('--include is empty')
  })

  it('refuses --include together with --all', () => {
    const both = run(['backup', 'create', '--include', 'global:settings', '--all'])
    expect(both.status).toBe(1)
    expect(both.output).toContain('exclusive')
  })

  it('refuses restore with no archive name', () => {
    const missing = run(['backup', 'restore'])
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('needs the archive name')
  })

  it('refuses an unknown action instead of guessing', () => {
    const unknown = run(['backup', 'destroy'])
    expect(unknown.status).toBe(1)
    expect(unknown.output).toContain('unknown action')
  })
})
