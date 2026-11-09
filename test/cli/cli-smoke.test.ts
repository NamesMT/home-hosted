import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { root, smokeHome, smokeRunner } from '../support/cli-smoke'

/**
 * One cheap spawned-process guard: the curated `--help` still lists every
 * command and flag, and an unknown command still exits 1 with the old text.
 * `--help` is answered before any state module resolves, and the throwaway home
 * keeps the suite away from a real one.
 */

const home = smokeHome()
const runCli = smokeRunner(home)

describe('cli smoke', () => {
  it('--help exits 0 and still lists every command and curated flag', () => {
    const help = runCli(['--help'])
    expect(help.status, help.stderr).toBe(0)

    for (const command of ['up', 'down', 'restart', 'status', 'logs', 'start', 'stop', 'set-password', 'set-token', 'migrate', 'init', 'ui-switch', 'ui-revert'])
      expect(help.stdout, command).toContain(command)

    for (const flag of ['--port', '--host', '--open', '--no-autostart', '--foreground', '--print-config', '--home', '--project'])
      expect(help.stdout, flag).toContain(flag)

    expect(help.stdout).toContain('Options for up/restart')
    expect(help.stdout).toContain('Environment')
    // Colours are for a terminal: piped help stays plain.
    expect(help.stdout).not.toContain('\x1B[')
  })

  /**
   * A command module must not restate its own description.
   *
   * `cli.ts` holds the one copy (`SYNOPSIS` + `SUMMARIES`) and renders it through `commandHelp`, which
   * `main()` intercepts *before* citty sees `--help`. `runCommand` — not `runMain` — is used precisely so
   * citty's own usage printer never runs, and that printer is the only thing that reads a subcommand's
   * `meta.description`. So each module's copy was unreachable, and three had already drifted:
   * `migrate` said "bring the state up to this release's layout and schema" while the help said
   * "bring the config up to this release's schema", with `up` and `ui-update` diverging too.
   *
   * Checked every CLI output path before deleting them: the divergent text appeared in none.
   */
  it('keeps each command description in one place, not two', () => {
    const dir = path.join(root, 'src', 'cli')
    const offenders = fs.readdirSync(dir)
      .filter(name => name.endsWith('.ts'))
      // `nanny.ts` is the one exemption, and it is deliberate: it is dispatched *before* the curated
      // surface (`cli.ts`, "citty owns its own `--help` for it"), so its description really is read.
      .filter(name => name !== 'nanny.ts')
      // The window has to stop at the `meta` object's own closing brace. A fixed 200-character
      // look-ahead reached into `args:`, so a one-line `meta: { name: 'free-port' }` followed by an
      // argument description was reported as a duplicated summary — the guard was right about the
      // rule and wrong about where the `meta` block ends.
      .filter(name => /meta:\s*\{[^{}]*description:/.test(fs.readFileSync(path.join(dir, name), 'utf8')))
    expect(offenders, 'the summary lives in cli.ts; a module copy is unreachable and drifts').toEqual([])
  })

  it('scopes `--help` to the command it follows', () => {
    const up = runCli(['up', '--help'])
    expect(up.status, up.stderr).toBe(0)
    expect(up.stdout).toContain('home-hosted up [options]')
    expect(up.stdout).toContain('--port')
    expect(up.stdout).toContain('--foreground')
    // `--config` is gone: `up` reads the default workspace's own servers file, always.
    expect(up.stdout).not.toContain('--config')
    // A command with options must not leak another command's option-only text.
    expect(up.stdout).not.toContain('--pm')
    expect(up.stdout).not.toContain('--generate')
    // The shared trailer still comes along.
    expect(up.stdout).toContain('--home')
    expect(up.stdout).toContain('Alias')
    expect(up.stdout).toContain('Environment')

    const status = runCli(['status', '--help'])
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toContain('--json')
    expect(status.stdout).not.toContain('--foreground')

    const uiSwitch = runCli(['ui-switch', '-h'])
    expect(uiSwitch.status, uiSwitch.stderr).toBe(0)
    expect(uiSwitch.stdout).toContain('--asset')
    expect(uiSwitch.stdout).not.toContain('--pm')

    // The per-server commands take a bare id, and their help has to say so.
    const start = runCli(['start', '--help'])
    expect(start.status, start.stderr).toBe(0)
    expect(start.stdout).toContain('home-hosted start <id>')
    expect(start.stdout).toContain('<id>')
    expect(start.stdout).not.toContain('--foreground')

    // `down` used to advertise no options; `--with-persistent` is the first one it has.
    const down = runCli(['down', '--help'])
    expect(down.status, down.stderr).toBe(0)
    expect(down.stdout).toContain('--with-persistent')
    // `--port` is `up`'s, so seeing it here would mean another command's section leaked.
    expect(down.stdout).not.toContain('--port')

    // Still a command with nothing of its own to offer.
    const revert = runCli(['ui-revert', '--help'])
    expect(revert.status, revert.stderr).toBe(0)
    expect(revert.stdout).toContain('no options')
    expect(revert.stdout).not.toContain('--asset')
  })

  it('offers --with-persistent on both commands that take it', () => {
    // One flag, two commands: a person should not have to remember which spelling is which.
    for (const name of ['down', 'restart']) {
      const text = runCli([name, '--help'])
      expect(text.status, name).toBe(0)
      expect(text.stdout, name).toContain('--with-persistent')
    }
    // `up` does not: there is nothing being stopped for it to affect.
    expect(runCli(['up', '--help']).stdout).not.toContain('--with-persistent')
  })

  it('refuses a flag the command no longer takes, rather than ignoring it', () => {
    // `--config` used to pin the default workspace's servers file for one process. It is gone:
    // a value that silently did nothing would leave a launcher supervising the wrong entries.
    for (const argv of [['up', '--config', 'pinned.json'], ['up', '-c', 'pinned.json'], ['migrate', '-c', 'pinned.json']]) {
      const result = runCli(argv)
      expect(result.status, argv.join(' ')).toBe(1)
      expect(result.stderr, argv.join(' ')).toContain('Unknown option')
    }
  })

  /**
   * A command that takes no options refuses the ones it is given.
   *
   * `ui-revert` declared no `args` at all, and `rejectUnknownFlags` read that as "parses its own
   * argv" — true of `ui-switch`, which calls `parseArgs`, and false here, where nothing parsed
   * anything. Every flag was therefore dropped before citty saw it: `ui-revert --dry-run` printed
   * "custom UI removed" and **deleted the installed UI**, exiting 0. Its definition is empty now,
   * which states that it takes nothing rather than leaving that unsaid.
   */
  it('refuses any flag or stray word on a command that takes no options', () => {
    for (const argv of [['ui-revert', '--dry-run'], ['ui-revert', '--bogus'], ['ui-revert', 'nonsense']]) {
      const result = runCli(argv)
      expect(result.status, argv.join(' ')).toBe(1)
      expect(result.stderr, argv.join(' ')).toMatch(/Unknown option|Unexpected argument/)
    }
    // With no argument it still does its one job, and says so.
    const plain = runCli(['ui-revert'])
    expect(plain.status, plain.stderr).toBe(0)
  })

  it('an unknown command exits 1 with the usage and the old wording', () => {
    const result = runCli(['nonsense'])
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('unknown command: nonsense')
    expect(result.stderr).toContain('home-hosted — a control panel')
  })

  /**
   * A typo should name the command it meant, not just print the whole reference.
   *
   * `restar` is one edit from `restart`; printing 25 lines of usage leaves the reader to spot it.
   * The list comes from `SYNOPSIS`, the same source the reference renders, so a suggestion can never
   * name a command that does not exist.
   */
  it('suggests the closest command when one is misspelled', () => {
    const typo = runCli(['restar'])
    expect(typo.status, typo.stderr).toBe(1)
    expect(typo.stderr).toContain('unknown command: restar')
    expect(typo.stderr, 'a one-edit typo names the command it meant').toContain('did you mean `restart`')

    // A transposition, not just a missing letter.
    expect(runCli(['stats']).stderr).toContain('did you mean `status`')

    // Nothing close: suggest nothing rather than guessing at an unrelated command.
    const far = runCli(['zebra'])
    expect(far.stderr).toContain('unknown command: zebra')
    expect(far.stderr, 'an unrelated word must not be given a wrong suggestion').not.toContain('did you mean')
  })

  /** The supervisor lives in the daemon, so `start` has to say what it is missing. */
  it('start/stop name the missing piece instead of failing obscurely', () => {
    const noId = runCli(['start'])
    expect(noId.status, noId.stderr).toBe(1)
    expect(noId.stderr).toContain('needs a server id')

    const noPanel = runCli(['stop', 'web'])
    expect(noPanel.status, noPanel.stderr).toBe(1)
    expect(noPanel.stderr).toContain('home-hosted is not running')
  })

  it('--version prints the package version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
    const result = runCli(['--version'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })
})

/**
 * `--print-config` reads the two files people hand-edit, so it reads them the way their editor
 * saved them.
 *
 * It used a plain `readFileSync(..., 'utf8')` inside a `try`, so a BOM — what PowerShell 5.1's
 * `Set-Content -Encoding UTF8` and Notepad's "UTF-8 with BOM" both write — made `JSON.parse` throw
 * and the handler return `null`. The command then printed `"settings": null` for a workspace whose
 * file was perfectly good, which is the "cannot parse" misreading `readStateFile` exists to stop,
 * said by the one command a person runs to ask what the panel actually read.
 */
describe('print-config reads hand-edited files', () => {
  it('reports settings an editor saved with a byte-order mark', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-print-config-'))
    const dir = path.join(home, '.hh')
    try {
      fs.mkdirSync(path.join(dir, 'default', '.state'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }))
      fs.writeFileSync(
        path.join(dir, 'default', 'settings.json'),
        Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ logs: { keep: 3 } }))]),
      )

      const printed = smokeRunner(home)(['up', '--print-config'])
      const config = JSON.parse(printed.stdout) as { workspaces: Array<{ settings: { logs?: { keep?: number } } | null }> }
      expect(config.workspaces[0]!.settings, 'a BOM must not read as "no settings"').not.toBeNull()
      expect(config.workspaces[0]!.settings!.logs?.keep).toBe(3)
    }
    finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
