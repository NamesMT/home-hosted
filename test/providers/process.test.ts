import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { needsShell, resolveCommand, resolveCwd } from '#src/providers/process'

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

/**
 * A `node_modules/.bin` directory holding exactly the named files.
 *
 * `asNpmWould` writes what `npm`/`pnpm` actually install for a dependency, which differs by
 * platform: the bare name on POSIX, and the bare `#!/bin/sh` shim **plus** `mytool.cmd` on Windows.
 * The cross-platform cases need that, because `resolveCommand` correctly refuses the extension-less
 * shim on Windows and an npm-shaped directory is the only one that resolves there.
 *
 * The Windows-specific cases below must *not* use it: several of them exist precisely to describe a
 * directory that lacks the `.cmd` (`never resolves to the extension-less POSIX script`) or holds
 * one shim kind alone, so they write their exact layout with the plain form.
 */
function binDirWith(...commands: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bin-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  for (const command of commands)
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', command), '')
  return root
}

/** `binDirWith`, holding what npm installs for each bare name on *this* platform. */
function npmBinDirWith(...commands: string[]): string {
  return binDirWith(...commands.flatMap((command) => {
    if (process.platform !== 'win32' || path.extname(command) !== '')
      return [command]
    return [command, `${command}.cmd`]
  }))
}

describe('resolveCommand', () => {
  it('leaves a path alone, so an absolute or relative command is not searched', () => {
    expect(resolveCommand('/usr/bin/node')).toBe('/usr/bin/node')
    expect(resolveCommand('./local.sh')).toBe('./local.sh')
    expect(resolveCommand('bin\\thing.exe')).toBe('bin\\thing.exe')
  })

  /** The file a resolved dependency actually starts: the bare shim on POSIX, the `.cmd` on Windows. */
  function resolvedName(): string {
    return process.platform === 'win32' ? 'mytool.cmd' : 'mytool'
  }

  it('finds a project dependency in node_modules/.bin', () => {
    const project = npmBinDirWith('mytool')
    expect(resolveCommand('mytool', project)).toBe(path.join(project, 'node_modules', '.bin', resolvedName()))
  })

  it('searches the entry directory before the project, in the order given', () => {
    // Both have it: the first search dir must win, which is what makes an entry's own install take
    // precedence over the project's copy.
    const entry = npmBinDirWith('mytool')
    const project = npmBinDirWith('mytool')
    expect(resolveCommand('mytool', entry, project)).toBe(path.join(entry, 'node_modules', '.bin', resolvedName()))
    expect(resolveCommand('mytool', project, entry)).toBe(path.join(project, 'node_modules', '.bin', resolvedName()))
  })

  it('returns the command unchanged when nothing has it, so PATH still decides', () => {
    expect(resolveCommand('definitely-not-installed-xyz', binDirWith('other'))).toBe('definitely-not-installed-xyz')
  })
})

/**
 * What `npm`/`pnpm` leave in `node_modules/.bin` on Windows, and which of it Node can start.
 *
 * All three names exist for one dependency: `mytool` is a `#!/bin/sh` script (the POSIX shim),
 * `mytool.cmd` is the Windows entry point and `mytool.ps1` a PowerShell variant. Resolving to the
 * extension-less file is resolving to a script with no interpreter — `spawn` answers `ENOENT`, and
 * the panel reported that as a missing program rather than as its own wrong pick.
 *
 * `process.platform` is read at call time and is overridable, so the Win32 branch is exercised on
 * this Linux runner instead of waiting for the cross-platform CI job — the branch is a search
 * order, which is exactly what a runner of the other OS never executes. The entry name is the
 * one npm itself writes, so the fixture is what a real `pnpm install` produces.
 */
describe('resolveCommand on Windows', () => {
  const saved = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: saved, configurable: true })
  })

  function asWindows(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  }

  it('prefers the .cmd over the POSIX script npm also writes under the bare name', () => {
    asWindows()
    const project = binDirWith('mytool', 'mytool.cmd')
    expect(resolveCommand('mytool', project)).toBe(path.join(project, 'node_modules', '.bin', 'mytool.cmd'))
  })

  it('prefers a native .exe over every script shim', () => {
    asWindows()
    const project = binDirWith('mytool', 'mytool.cmd', 'mytool.exe')
    expect(resolveCommand('mytool', project)).toBe(path.join(project, 'node_modules', '.bin', 'mytool.exe'))
  })

  it('falls through to .bat when that is the only Windows executable present', () => {
    asWindows()
    const project = binDirWith('mytool', 'mytool.bat')
    expect(resolveCommand('mytool', project)).toBe(path.join(project, 'node_modules', '.bin', 'mytool.bat'))
  })

  it('never resolves to the extension-less POSIX script, even as a last resort', () => {
    asWindows()
    // Only the sh script exists: the honest answer is the bare name, so PATH decides, rather
    // than a path Node is guaranteed to fail on.
    const project = binDirWith('mytool')
    expect(resolveCommand('mytool', project)).toBe('mytool')
  })

  /**
   * `pnpm`/`npm` on PATH are `.cmd` shims. Returned bare, `needsShell` said no and `spawn` (which only
   * appends `.com`/`.exe`) answered `ENOENT` for a program that is installed.
   */
  it('names the .cmd a bare command resolves to on PATH, so it is spawned through a shell', () => {
    asWindows()
    const savedPath = process.env.PATH
    const savedExt = process.env.PATHEXT
    try {
      const bin = binDirWith()
      const onPath = path.join(bin, 'node_modules', '.bin')
      fs.writeFileSync(path.join(onPath, 'pnpm.cmd'), '')
      fs.writeFileSync(path.join(onPath, 'node.exe'), '')
      process.env.PATH = onPath
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
      expect(resolveCommand('pnpm')).toBe('pnpm.cmd')
      expect(needsShell(resolveCommand('pnpm'))).toBe(true)
      // An .exe needs no shell and spawn finds it itself.
      expect(resolveCommand('node')).toBe('node')
      expect(resolveCommand('absent-xyz')).toBe('absent-xyz')
    }
    finally {
      process.env.PATH = savedPath
      if (savedExt === undefined)
        delete process.env.PATHEXT
      else
        process.env.PATHEXT = savedExt
    }
  })

  it('searches an explicitly named shim literally, without trying other extensions', () => {
    asWindows()
    const project = binDirWith('mytool.cmd', 'mytool.exe')
    // The person named `.cmd`, so that is the file looked up — no extension shopping on top of
    // an explicit choice.
    expect(resolveCommand('mytool.cmd', project)).toBe(path.join(project, 'node_modules', '.bin', 'mytool.cmd'))
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
