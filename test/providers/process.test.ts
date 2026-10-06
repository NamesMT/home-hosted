import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveCommand, resolveCwd } from '#src/providers/process'

/**
 * The two pure helpers on the spawn path.
 *
 * `resolveCommand` decides which binary a supervised entry actually runs, and the search order is the
 * point: an entry's own `node_modules/.bin` is looked at before the project's, so a server installed
 * as a project dependency is found even when the launcher's PATH has no pnpm-injected bin dir. No test
 * file existed for this module, so the order and the fallback were both unverified.
 */
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

function binDirWith(command: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bin-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', command), '')
  return root
}

describe('resolveCommand', () => {
  it('leaves a path alone, so an absolute or relative command is not searched', () => {
    expect(resolveCommand('/usr/bin/node')).toBe('/usr/bin/node')
    expect(resolveCommand('./local.sh')).toBe('./local.sh')
    expect(resolveCommand('bin\\thing.exe')).toBe('bin\\thing.exe')
  })

  it('finds a project dependency in node_modules/.bin', () => {
    const project = binDirWith('mytool')
    expect(resolveCommand('mytool', project)).toBe(path.join(project, 'node_modules', '.bin', 'mytool'))
  })

  it('searches the entry directory before the project, in the order given', () => {
    // Both have it: the first search dir must win, which is what makes an entry's own install take
    // precedence over the project's copy.
    const entry = binDirWith('mytool')
    const project = binDirWith('mytool')
    expect(resolveCommand('mytool', entry, project)).toBe(path.join(entry, 'node_modules', '.bin', 'mytool'))
    expect(resolveCommand('mytool', project, entry)).toBe(path.join(project, 'node_modules', '.bin', 'mytool'))
  })

  it('returns the command unchanged when nothing has it, so PATH still decides', () => {
    expect(resolveCommand('definitely-not-installed-xyz', binDirWith('other'))).toBe('definitely-not-installed-xyz')
  })
})

describe('resolveCwd', () => {
  it('resolves a relative entry path against the project, and keeps an absolute one', () => {
    expect(resolveCwd('sub', '/base')).toBe(path.resolve('/base', 'sub'))
    expect(resolveCwd('/abs', '/base')).toBe(path.resolve('/abs'))
    // `..` is resolved rather than passed through, so the caller gets one canonical directory.
    expect(resolveCwd('../x', '/base/sub')).toBe(path.resolve('/base/x'))
  })
})
