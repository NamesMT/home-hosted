import type { ArgsDef } from 'citty'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDirFlags, buildDaemonArgv, extractDirFlags, flagTarget, rejectUnknownFlags, resolveInvocation } from '#src/cli/args'

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

  it('reads `help <command>` and `<command> help` as that command\'s help', () => {
    expect(resolveInvocation(['help', 'up'], commands)).toEqual({ kind: 'help', command: 'up' })
    expect(resolveInvocation(['up', 'help'], commands)).toEqual({ kind: 'help', command: 'up' })
    // Not a command: the whole reference, as before.
    expect(resolveInvocation(['help', 'nope'], commands)).toEqual({ kind: 'help' })
    // A bare id comes first for these, so `help` there is a server named help.
    expect(resolveInvocation(['start', 'help'], [...commands, 'start'])).toEqual({ kind: 'command', argv: ['start', 'help'] })
  })

  it('reads a bare help or version after a command as that option value', () => {
    // `ui-switch --asset help` used to print the usage and install nothing.
    expect(resolveInvocation(['ui-switch', '--asset', 'help'], commands)).toEqual({ kind: 'command', argv: ['ui-switch', '--asset', 'help'] })
    expect(resolveInvocation(['ui-switch', '--tag', 'version'], commands)).toEqual({ kind: 'command', argv: ['ui-switch', '--tag', 'version'] })
    expect(resolveInvocation(['up', '--port', 'help'], commands)).toEqual({ kind: 'command', argv: ['up', '--port', 'help'] })
  })
})

describe('buildDaemonArgv', () => {
  const base = { autostart: true, open: false, foreground: false, printConfig: false }

  it('always starts with `up --foreground`', () => {
    expect(buildDaemonArgv(base)).toEqual(['up', '--foreground'])
  })

  it('forwards every flag the daemon needs', () => {
    expect(buildDaemonArgv({
      port: 4321,
      host: 'lan',
      autostart: false,
      open: true,
      foreground: false,
      printConfig: false,
    })).toEqual([
      'up',
      '--foreground',
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
  /**
   * A mistyped flag names the one it meant, the way a mistyped command does.
   *
   * `rejectUnknownFlags` already holds the `ArgsDef`, so the valid names are all there — an unknown
   * option needs no more information than an unknown command to say which one was meant. `--autostart`
   * for `--no-autostart` is the case that matters: the old message named only the mistake.
   */
  it('suggests the closest option when one is misspelled', () => {
    // One edit from `--port`.
    expect(rejectUnknownFlags(['--prt'], args)).toContain('did you mean `--port`?')
    // A transposition of a declared flag, and one that is only reachable as `--no-<flag>`.
    expect(rejectUnknownFlags(['--pritn-config'], args)).toContain('did you mean `--print-config`?')
    expect(rejectUnknownFlags(['--no-autostar'], args)).toContain('did you mean `--no-autostart`?')
    // Nothing close: say nothing rather than guessing.
    expect(rejectUnknownFlags(['--zzzzzz'], args)).toBe('Unknown option \'--zzzzzz\'')
  })

  it('refuses an option nobody declared, and a stray argument', () => {
    expect(rejectUnknownFlags(['--bogus'], args)).toBe('Unknown option \'--bogus\'')
    expect(rejectUnknownFlags(['--open'], args)).toBe('Unknown option \'--open\'')
    expect(rejectUnknownFlags(['--no-open'], args)).toBe('Unknown option \'--no-open\'')
    expect(rejectUnknownFlags(['extra'], args)).toBe('Unexpected argument \'extra\'')
    expect(rejectUnknownFlags(['--port'], args)).toBe('Option \'--port\' needs a value')
  })

  it('leaves a command that declares no arguments to its own parser', () => {
    expect(rejectUnknownFlags(['--anything', 'x'], undefined)).toBeNull()
  })

  /**
   * An **empty** definition is a statement, not an absence: this command takes nothing.
   *
   * Both forms used to answer `null`, so `ui-revert` — which declares no `args` and parses none
   * either — accepted and discarded every flag: `ui-revert --dry-run` deleted the installed UI and
   * exited 0. `ui-switch` is the one that really does parse its own argv (via `node:util`'s
   * `parseArgs`), and it declares no `args` key at all, which stays `undefined`.
   */
  it('refuses everything for a command whose definition is empty', () => {
    expect(rejectUnknownFlags(['--anything'], {})).not.toBeNull()
    expect(rejectUnknownFlags(['stray'], {})).not.toBeNull()
    expect(rejectUnknownFlags([], {})).toBeNull()
  })

  /**
   * `start <id>` is the one command with a bare argument, and the guard has to know
   * about it: every other bare word is still the stray argument it always was.
   */
  it('accepts a declared positional, and only that many', () => {
    const start: ArgsDef = { id: { type: 'positional' } }

    expect(rejectUnknownFlags(['web'], start)).toBeNull()
    expect(rejectUnknownFlags(['web', 'extra'], start)).toBe('Unexpected argument \'extra\'')
    expect(rejectUnknownFlags(['--id', 'web'], start)).toBe('Unknown option \'--id\'')
    expect(rejectUnknownFlags(['web'], args)).toBe('Unexpected argument \'web\'')
  })

  it('stops at `--`, which is where arguments start', () => {
    expect(rejectUnknownFlags(['--', '--not-an-option'], args)).toBeNull()
  })
})

/**
 * A group (`job`, whose words are `ls`/`run`/`log`) declares its flags one level down.
 *
 * `rejectUnknownFlags` was handed the group's own `args`, which is `undefined` — the spelling that
 * means "this command parses its own argv". So every flag of every subcommand was accepted and
 * dropped: measured on a live panel, `job ls --jsn` printed the human table (exit 0) and a script
 * parsing it as JSON got prose, and `job run <id> --jsn` **ran the job**. `flagTarget` is the
 * resolution the group case was missing.
 */
describe('flagTarget', () => {
  const ls = { args: { json: { type: 'boolean' } } as ArgsDef }
  const run = { args: { id: { type: 'positional' }, json: { type: 'boolean' } } as ArgsDef }
  const group = { subCommands: { ls, run } }

  it('resolves the subcommand\'s own definition, not the group\'s', async () => {
    const resolved = await flagTarget(['ls', '--json'], group)
    expect(resolved.args).toEqual(ls.args)
    // The subcommand word is the group's to consume, so it must not reach the subcommand's
    // positionals as an unexpected argument.
    expect(resolved.argsFor).toEqual(['--json'])
  })

  it('takes the first bare word, wherever the flags around it sit', async () => {
    expect((await flagTarget(['--json', 'ls'], group)).args).toEqual(ls.args)
    expect((await flagTarget(['run', 'nightly', '--json'], group)).args).toEqual(run.args)
    expect((await flagTarget(['run', 'nightly', '--json'], group)).argsFor).toEqual(['nightly', '--json'])
  })

  it('falls back to the group\'s own definition when no subcommand is named', async () => {
    // `--json` with no subcommand is citty's to refuse ("No command specified"), not this guard's.
    const none = await flagTarget(['--json'], group)
    expect(none.args).toBeUndefined()
    expect(none.argsFor).toEqual(['--json'])
    // An unknown word is a subcommand citty refuses by name; validating it as one is not this guard's job.
    expect((await flagTarget(['bogus'], group)).args).toBeUndefined()
  })

  it('passes a plain command through unchanged', async () => {
    const plainArgs: ArgsDef = { port: { type: 'string', alias: 'p' } }
    const resolved = await flagTarget(['--port', '4000'], { args: plainArgs })
    expect(resolved.args).toEqual(plainArgs)
    expect(resolved.argsFor).toEqual(['--port', '4000'])
  })

  it('works with lazily-defined subcommands, as citty takes them', async () => {
    const lazy = { subCommands: { ls: () => ls } }
    expect((await flagTarget(['ls'], lazy)).args).toEqual(ls.args)
    const asyncLazy = { subCommands: { ls: async () => ls } }
    expect((await flagTarget(['ls'], asyncLazy)).args).toEqual(ls.args)
    // A `subCommands` that is itself lazy resolves too.
    const lazyGroup = { subCommands: async () => ({ ls }) }
    expect((await flagTarget(['ls'], lazyGroup)).args).toEqual(ls.args)
  })

  /**
   * No command answers a person with citty's internal wording.
   *
   * Two did. `job` alone printed `No command specified.` — because its parent `defineCommand` declared
   * `subCommands` but neither `args` nor `run`, so citty's own guard fired. `import` with a missing
   * positional printed `Missing required positional argument: KIND`, naming a `KIND` that appears in no
   * help text, because both positionals were `required: true` and citty refused before `run` — which
   * already said both things better — was reached.
   *
   * Every other command answers `use \`home-hosted <command> …\``. This pins the whole set, by running
   * each one bare and refusing citty's three phrasings. `Unknown command` is deliberately **allowed**: it
   * is citty's answer to a word that names no subcommand, and it reads correctly.
   */
  it('never lets citty\'s own wording reach a person', async () => {
    const { runCli } = await import('../support/run-cli')
    const commands = ['job', 'import', 'token', 'account', 'secret', 'backup', 'service', 'logs', 'status', 'ui-switch']
    const leaked: string[] = []
    for (const command of commands) {
      // Each of these needs a running panel or an interactive terminal to do anything; the refusal is
      // the message under test, whatever it turns out to be.
      const result = runCli([command], { home: path.join(process.cwd(), '.cli-wording-probe'), timeout: 20_000 })
      const first = result.output.trim().split('\n')[0] ?? ''
      for (const phrase of ['No command specified', 'Missing required positional argument']) {
        if (first.includes(phrase))
          leaked.push(`${command}: ${first}`)
      }
      /**
       * A command that could not even load says nothing about its wording, so it must not pass as clean.
       *
       * This is how the check first fooled me: an injected syntax error in `job.ts` made the CLI die
       * with `Transform failed … Expected ";"`, which matched neither phrase, so the case went green
       * while the thing under test had never run.
       *
       * `backup` and `service` are allowed to *report state* rather than refuse — `backup` says "no
       * backups yet", `service` says "not installed" — so the rule is narrower than "must start with
       * `error`": a crash is a stack frame or a module-loader failure, and those are what to refuse.
       */
      if (first.includes('Transform failed') || /^\s+at /.test(first) || first.includes('ERR_MODULE_NOT_FOUND'))
        leaked.push(`${command}: the CLI did not load — ${first}`)
    }
    expect(leaked, 'a command answered with citty\'s internal wording instead of its own usage').toEqual([])
  })
})
