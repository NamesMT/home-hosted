import { describe, expect, it } from 'vitest'
import { backupArgsCli } from '../support/backup-args'

/**
 * The flag rules that guard a destructive command, checked without a panel.
 *
 * `backup create`/`restore` write over live data, so the failures worth pinning are the ones where a
 * mistyped flag would *widen* the scope rather than refuse. Both run before the CLI reaches for a
 * running panel, so a missing panel is the only reason these need a throwaway home.
 */

const { run } = backupArgsCli()

describe('backup flag guards', () => {
  it('refuses an empty --include rather than widening to everything', () => {
    // The bug this pins: `--include ""` parsed to an empty list, the request then omitted it, and a
    // "restore nothing" became a full restore over live data.
    const empty = run(['backup', 'create', '--include', ''])
    expect(empty.status, empty.output).toBe(1)
    expect(empty.output).toContain('--include is empty')
    expect(empty.output).toContain('--all')
  })

  it('refuses a --include made only of separators', () => {
    const commas = run(['backup', 'create', '--include', ',,,'])
    expect(commas.status, commas.output).toBe(1)
    expect(commas.output).toContain('--include is empty')
  })

  it('refuses --include together with --all', () => {
    const both = run(['backup', 'create', '--include', 'global:settings', '--all'])
    expect(both.status, both.output).toBe(1)
    expect(both.output).toContain('exclusive')
  })

  it('refuses create with neither --include nor --all', () => {
    // "Neither flag" used to mean everything, so `create --confirm` archived the whole machine
    // without anyone naming what they meant. It now refuses and lists what could be picked.
    const none = run(['backup', 'create', '--confirm'])
    expect(none.status, none.output).toBe(1)
    expect(none.output).toContain('name what to act on')
    expect(none.output).toContain('--all')
  })

  it('refuses restore with neither --include nor --all', () => {
    const none = run(['backup', 'restore', 'anything.zip', '--confirm'])
    expect(none.status, none.output).toBe(1)
    expect(none.output).toContain('name what to act on')
  })

  it('refuses an empty --exclude rather than excluding nothing', () => {
    // An unset `$LIST` in a script must not silently leave the secrets in the archive.
    const none = run(['backup', 'create', '--all', '--exclude', ''])
    expect(none.status, none.output).toBe(1)
    expect(none.output).toContain('--exclude is empty')
  })

  it('lists what could be backed up when neither flag is given', () => {
    // A refusal that names no ids reads as "there is nothing to back up".
    const none = run(['backup', 'create'])
    expect(none.status, none.output).toBe(1)
    expect(none.output).toContain('name what to act on')
    expect(none.output).toContain('--exclude')
  })
})
