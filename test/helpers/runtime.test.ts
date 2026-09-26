import { afterEach, describe, expect, it } from 'vitest'
import { NANNY_COMMAND, nannyArgv, runtimeArgs } from '#src/helpers/runtime'

/**
 * How this CLI re-runs itself. Both a detached `up` and a persistent entry's nanny
 * depend on it, and a wrong argv is a process that never starts — so the mapping is
 * pinned here rather than discovered in the field.
 */

const originalExecArgv = process.execArgv

afterEach(() => {
  process.execArgv = originalExecArgv
})

describe('runtimeArgs', () => {
  it('resolves a tsx loader to a real path, because a child does not share this cwd', () => {
    process.execArgv = ['--import', 'tsx']
    const args = runtimeArgs()

    expect(args[0]).toBe('--import')
    expect(args[1]).not.toBe('tsx')
    expect(args[1]).toMatch(/tsx/)
  })

  it('resolves the --import=tsx spelling too', () => {
    process.execArgv = ['--import=tsx', '--enable-source-maps']
    const [loader, other] = runtimeArgs()

    expect(loader).toMatch(/^--import=.+tsx/)
    // Anything else is passed through untouched.
    expect(other).toBe('--enable-source-maps')
  })

  it('leaves an unrelated runtime alone', () => {
    process.execArgv = ['--no-warnings', '--experimental-vm-modules']
    expect(runtimeArgs()).toEqual(['--no-warnings', '--experimental-vm-modules'])
  })

  it('is empty for a plain node invocation', () => {
    process.execArgv = []
    expect(runtimeArgs()).toEqual([])
  })

  it('produces the same loader path every time', () => {
    process.execArgv = ['tsx']
    expect(runtimeArgs()[0]).toBe(runtimeArgs()[0])
  })
})

describe('nannyArgv', () => {
  it('names the hidden command and passes both files explicitly', () => {
    process.execArgv = []
    expect(nannyArgv('/pkg/src/cli.ts', 'web', '/state/web.spec.json', '/state/web.json')).toEqual([
      '/pkg/src/cli.ts',
      '__nanny',
      '--id',
      'web',
      '--spec',
      '/state/web.spec.json',
      '--state',
      '/state/web.json',
    ])
  })

  it('carries this runtime in front, so tsx works for the nanny too', () => {
    process.execArgv = ['--import', 'tsx']
    const argv = nannyArgv('/pkg/src/cli.ts', 'web', 's', 't')
    expect(argv[0]).toBe('--import')
    expect(argv[1]).toMatch(/tsx/)
    expect(argv[2]).toBe('/pkg/src/cli.ts')
  })

  it('matches the constant the identity check reads back', () => {
    process.execArgv = []
    expect(NANNY_COMMAND).toBe('__nanny')
    expect(nannyArgv('entry', 'id', 'spec', 'state')).toContain(NANNY_COMMAND)
  })
})
