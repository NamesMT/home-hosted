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

  it('refuses create with neither --include nor --all', () => {
    // "Neither flag" used to mean everything, so `create --confirm` archived the whole machine
    // without anyone naming what they meant. It now refuses and lists what could be picked.
    const none = run(['backup', 'create', '--confirm'])
    expect(none.status).toBe(1)
    expect(none.output).toContain('name what to act on')
    expect(none.output).toContain('--all')
  })

  it('refuses restore with neither --include nor --all', () => {
    const none = run(['backup', 'restore', 'anything.zip', '--confirm'])
    expect(none.status).toBe(1)
    expect(none.output).toContain('name what to act on')
  })

  it('refuses an empty --exclude rather than excluding nothing', () => {
    // An unset `$LIST` in a script must not silently leave the secrets in the archive.
    const none = run(['backup', 'create', '--all', '--exclude', ''])
    expect(none.status).toBe(1)
    expect(none.output).toContain('--exclude is empty')
  })

  it('lists what could be backed up when neither flag is given', () => {
    // A refusal that names no ids reads as "there is nothing to back up".
    const none = run(['backup', 'create'])
    expect(none.status).toBe(1)
    expect(none.output).toContain('name what to act on')
    expect(none.output).toContain('--exclude')
  })

  it('refuses restore with no archive, and names both ways to give one', () => {
    const missing = run(['backup', 'restore'])
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('needs an archive')
    // A person on a blank host has no name to pass: the refusal must mention `--from`.
    expect(missing.output).toContain('--from')
  })

  it('refuses an archive name together with --from', () => {
    // Two different archives named at once: picking one silently is the wrong guess on the
    // command that overwrites live data.
    const both = run(['backup', 'restore', 'x.zip', '--from', '/tmp/x.zip'])
    expect(both.status).toBe(1)
    expect(both.output).toContain('not both')
  })

  it('refuses --from on an action that cannot read an archive', () => {
    // A flag silently ignored is a flag the person believed worked.
    const created = run(['backup', 'create', '--all', '--from', '/tmp/x.zip'])
    expect(created.status).toBe(1)
    expect(created.output).toContain('--from is for restore')

    const listed = run(['backup', 'list', '--from', '/tmp/x.zip'])
    expect(listed.status).toBe(1)
    expect(listed.output).toContain('--from is for restore')
  })

  /**
   * A path is a *file* question before it is a scope question.
   *
   * `restore --from /media/usb` (no `--all`, no `--include`) answered "name what to act on" to
   * someone who had already named their archive, hiding the real problem — a directory, or a typo.
   * Measured: the good sentence existed only one flag away, so it read as a scope mistake.
   */
  it('names a missing or non-file --from path before complaining about the scope', () => {
    const missing = run(['backup', 'restore', '--from', '/definitely/not/here.zip'])
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('no file at /definitely/not/here.zip')
    expect(missing.output).not.toContain('name what to act on')

    // A directory is the case `existsSync` alone says yes to.
    const dir = run(['backup', 'restore', '--from', home])
    expect(dir.status).toBe(1)
    expect(dir.output).toContain(`no file at ${home}`)
    expect(dir.output).not.toContain('name what to act on')
  })

  it('refuses an unknown action instead of guessing', () => {
    const unknown = run(['backup', 'destroy'])
    expect(unknown.status).toBe(1)
    expect(unknown.output).toContain('unknown action')
  })
})
