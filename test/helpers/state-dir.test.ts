import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '#src/helpers/atomic'
import { ensureStateDir, hhDir } from '#src/helpers/paths'

/**
 * `.hh` is the owner's alone, whichever command creates it.
 *
 * Only `up` used to set `0700`; anything else that got there first (`backup list`, a first
 * `set-password`) made it with a bare recursive `mkdir`, so `.hh` was `0755` until the first `up`.
 * Every creator goes through `ensureStateDir`, including `writeFileAtomic`.
 */
describe.skipIf(process.platform === 'win32')('ensureStateDir', () => {
  it('creates .hh at 0700 when a file deep inside it is the first thing written', () => {
    fs.rmSync(hhDir, { recursive: true, force: true })
    writeFileAtomic(path.join(hhDir, 'default', 'settings.json'), '{}\n')
    expect(fs.statSync(hhDir).mode & 0o777).toBe(0o700)
  })

  it('creates a directory outside .hh as asked, without touching .hh', () => {
    fs.rmSync(hhDir, { recursive: true, force: true })
    const outside = path.join(path.dirname(hhDir), 'elsewhere', 'deep')
    ensureStateDir(outside)
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(hhDir)).toBe(false)
  })
})
