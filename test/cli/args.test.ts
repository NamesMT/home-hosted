import type { ArgsDef } from 'citty'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDirFlags, buildDaemonArgv, extractDirFlags, rejectUnknownFlags, resolveInvocation } from '#src/cli/args'

/**
 * The work citty cannot do: the `--home`/`--project` pre-pass, the curated
 * `help`/`version`/`unknown command` dispatch, and the argv the detached daemon
 * is spawned with. All pure — no daemon, no network, no stdin.
 */

describe('extractDirFlags', () => {
  it('leaves argv alone when neither flag is present', () => {
    expect(extractDirFlags(['up', '-p', '4000', '--open'])).toEqual({
      rest: ['up', '-p', '4000', '--open'],
      home: undefined,
      project: undefined,
    })
    expect(extractDirFlags([])).toEqual({ rest: [], home: undefined, project: undefined })
  })

  it('peels off the separated form and keeps the order of the rest', () => {
    expect(extractDirFlags(['up', '--home', '/state', '-p', '4000', '--project', '/proj', '--open'])).toEqual({
      rest: ['up', '-p', '4000', '--open'],
      home: '/state',
      project: '/proj',
    })
  })

  it('peels off the `=` form too', () => {
    expect(extractDirFlags(['status', '--home=/state', '--project=/proj', '--json'])).toEqual({
      rest: ['status', '--json'],
      home: '/state',
      project: '/proj',
    })
  })

  it('keeps the last value when a flag is repeated', () => {
    const result = extractDirFlags(['--home', 'a', '--home=b'])
    expect(result.home).toBe('b')
    expect(result.error).toBeUndefined()
  })

  it('reports a flag with no usable value instead of failing', () => {
    expect(extractDirFlags(['--home'])).toMatchObject({ error: '--home needs a directory' })
    expect(extractDirFlags(['up', '--project'])).toMatchObject({ error: '--project needs a directory' })
    expect(extractDirFlags(['--home='])).toMatchObject({ error: '--home needs a directory' })
  })
})

describe('applyDirFlags', () => {
  const saved = { home: process.env.HHOSTED_HOME, project: process.env.HHOSTED_PROJECT }

  beforeEach(() => {
    delete process.env.HHOSTED_HOME
    delete process.env.HHOSTED_PROJECT
  })

  afterEach(() => {
    if (saved.home === undefined)
      delete process.env.HHOSTED_HOME
    else process.env.HHOSTED_HOME = saved.home
    if (saved.project === undefined)
      delete process.env.HHOSTED_PROJECT
    else process.env.HHOSTED_PROJECT = saved.project
  })

  it('resolves both to absolute paths in the environment', () => {
    applyDirFlags({ home: './state', project: './proj' })
    expect(process.env.HHOSTED_HOME).toBe(path.resolve('./state'))
    expect(process.env.HHOSTED_PROJECT).toBe(path.resolve('./proj'))
  })

  it('leaves a directory it was not given untouched', () => {
    applyDirFlags({ home: '/only-home' })
    expect(process.env.HHOSTED_HOME).toBe(path.resolve('/only-home'))
    expect(process.env.HHOSTED_PROJECT).toBeUndefined()
  })
})

describe('resolveInvocation', () => {
  const commands = ['up', 'down', 'status', 'ui-switch']

  it('reads no arguments as `up`', () => {
    expect(resolveInvocation([], commands)).toEqual({ kind: 'command', argv: ['up'] })
  })

  it('rewrites a leading flag to `up`', () => {
    expect(resolveInvocation(['-p', '4000'], commands)).toEqual({ kind: 'command', argv: ['up', '-p', '4000'] })
    expect(resolveInvocation(['--open'], commands)).toEqual({ kind: 'command', argv: ['up', '--open'] })
    expect(resolveInvocation(['--no-autostart', '--host', 'lan'], commands)).toEqual({
      kind: 'command',
      argv: ['up', '--no-autostart', '--host', 'lan'],
    })
  })

  it('dispatches a named command with its flags', () => {
    expect(resolveInvocation(['status', '--json'], commands)).toEqual({ kind: 'command', argv: ['status', '--json'] })
    expect(resolveInvocation(['ui-switch', '--file', 'x.zip'], commands)).toEqual({
      kind: 'command',
      argv: ['ui-switch', '--file', 'x.zip'],
    })
  })

  it('answers help and version, at the top level and on a command', () => {
    for (const argv of [['help'], ['--help'], ['-h']])
      expect(resolveInvocation(argv, commands), argv.join(' ')).toEqual({ kind: 'help' })

    // A help flag after a command keeps that command's name, so the curated text
    // can be scoped to it instead of dumping the whole reference.
    for (const argv of [['up', '--help'], ['up', '-h'], ['ui-switch', '--help']])
      expect(resolveInvocation(argv, commands), argv.join(' ')).toEqual({ kind: 'help', command: argv[0] })

    for (const argv of [['version'], ['--version'], ['-v'], ['up', '--version']])
      expect(resolveInvocation(argv, commands), argv.join(' ')).toEqual({ kind: 'version' })
  })

  it('reports an unknown first token rather than letting it start something', () => {
    expect(resolveInvocation(['nonsense'], commands)).toEqual({ kind: 'unknown', command: 'nonsense' })
    expect(resolveInvocation(['nonsense', '--json'], commands)).toEqual({ kind: 'unknown', command: 'nonsense' })
  })

  it('reads a bare help or version after a command as that option value', () => {
    // `ui-switch --asset help` used to print the usage and install nothing.
    expect(resolveInvocation(['ui-switch', '--asset', 'help'], commands)).toEqual({ kind: 'command', argv: ['ui-switch', '--asset', 'help'] })
    expect(resolveInvocation(['ui-switch', '--tag', 'version'], commands)).toEqual({ kind: 'command', argv: ['ui-switch', '--tag', 'version'] })
    expect(resolveInvocation(['up', '--config', 'help'], commands)).toEqual({ kind: 'command', argv: ['up', '--config', 'help'] })
  })
})

describe('buildDaemonArgv', () => {
  const base = { autostart: true, open: false, foreground: false, printConfig: false }

  it('always starts with `up --foreground`', () => {
    expect(buildDaemonArgv(base)).toEqual(['up', '--foreground'])
  })

  it('forwards every flag the daemon needs', () => {
    expect(buildDaemonArgv({
      config: '/state/servers.config.json',
      port: 4321,
      host: 'lan',
      autostart: false,
      open: true,
      foreground: false,
      printConfig: false,
    })).toEqual([
      'up',
      '--foreground',
      '--config',
      '/state/servers.config.json',
      '--port',
      '4321',
      '--host',
      'lan',
      '--no-autostart',
      '--open',
    ])
  })

  it('never forwards --foreground or --print-config as flags', () => {
    // `--foreground` is what makes the child the daemon; `--print-config` is
    // answered in the calling process and must not leave a daemon behind.
    expect(buildDaemonArgv({ ...base, foreground: true, printConfig: true })).toEqual(['up', '--foreground'])
  })
})

describe('rejectUnknownFlags', () => {
  const args: ArgsDef = {
    port: { type: 'string', alias: 'p' },
    autostart: { type: 'boolean', default: true },
    printConfig: { type: 'boolean' },
    yes: { type: 'boolean', alias: ['y', 'assume-yes'] },
  }

  it('accepts the flags a command declares, in either spelling', () => {
    for (const argv of [
      ['--port', '4000'],
      ['--port=4000'],
      ['-p', '4000'],
      ['--autostart'],
      ['--no-autostart'],
      ['--print-config'],
      ['--printConfig'],
      ['-y'],
      ['--assume-yes'],
      ['--port', '4000', '--no-autostart', '-y'],
      [],
    ])
      expect(rejectUnknownFlags(argv as string[], args), argv.join(' ')).toBeNull()
  })

  /**
   * citty parses permissively, so without this a mistyped flag silently does
   * nothing — `--autostart` where `--no-autostart` was meant would start the
   * panel with the wrong policy.
   */
  it('refuses an option nobody declared, and a stray argument', () => {
    expect(rejectUnknownFlags(['--bogus'], args)).toBe('Unknown option \'--bogus\'')
    expect(rejectUnknownFlags(['--open'], args)).toBe('Unknown option \'--open\'')
    expect(rejectUnknownFlags(['--no-open'], args)).toBe('Unknown option \'--no-open\'')
    expect(rejectUnknownFlags(['extra'], args)).toBe('Unexpected argument \'extra\'')
    expect(rejectUnknownFlags(['--port'], args)).toBe('Option \'--port\' needs a value')
  })

  it('leaves a command that declares no arguments to its own parser', () => {
    expect(rejectUnknownFlags(['--anything', 'x'], undefined)).toBeNull()
    expect(rejectUnknownFlags(['--anything'], {})).toBeNull()
  })

  it('stops at `--`, which is where arguments start', () => {
    expect(rejectUnknownFlags(['--', '--not-an-option'], args)).toBeNull()
  })
})
