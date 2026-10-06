import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * One cheap spawned-process guard: the curated `--help` still lists every
 * command and flag, and an unknown command still exits 1 with the old text.
 * `--help` is answered before any state module resolves, and the throwaway home
 * keeps the suite away from a real one.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cli-smoke-'))

function runCli(args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('cli smoke', () => {
  it('--help exits 0 and still lists every command and curated flag', () => {
    const help = runCli(['--help'])
    expect(help.status).toBe(0)

    for (const command of ['up', 'down', 'restart', 'status', 'logs', 'start', 'stop', 'set-password', 'set-token', 'migrate', 'init', 'ui-switch', 'ui-revert'])
      expect(help.stdout, command).toContain(command)

    for (const flag of ['--config', '--port', '--host', '--open', '--no-autostart', '--foreground', '--print-config', '--home', '--project'])
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
      .filter(name => /meta:\s*\{[\s\S]{0,200}?description:/.test(fs.readFileSync(path.join(dir, name), 'utf8')))
    expect(offenders, 'the summary lives in cli.ts; a module copy is unreachable and drifts').toEqual([])
  })

  it('scopes `--help` to the command it follows', () => {
    const up = runCli(['up', '--help'])
    expect(up.status).toBe(0)
    expect(up.stdout).toContain('home-hosted up [options]')
    expect(up.stdout).toContain('--config')
    expect(up.stdout).toContain('--foreground')
    // A command with options must not leak another command's option-only text.
    expect(up.stdout).not.toContain('--pm')
    expect(up.stdout).not.toContain('--generate')
    // The shared trailer still comes along.
    expect(up.stdout).toContain('--home')
    expect(up.stdout).toContain('Alias')
    expect(up.stdout).toContain('Environment')

    const status = runCli(['status', '--help'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('--json')
    expect(status.stdout).not.toContain('--foreground')

    const uiSwitch = runCli(['ui-switch', '-h'])
    expect(uiSwitch.status).toBe(0)
    expect(uiSwitch.stdout).toContain('--asset')
    expect(uiSwitch.stdout).not.toContain('--pm')

    // The per-server commands take a bare id, and their help has to say so.
    const start = runCli(['start', '--help'])
    expect(start.status).toBe(0)
    expect(start.stdout).toContain('home-hosted start <id>')
    expect(start.stdout).toContain('<id>')
    expect(start.stdout).not.toContain('--foreground')

    for (const [name, marker] of [['down', '--foreground'], ['ui-revert', '--asset']] as const) {
      const text = runCli([name, '--help'])
      expect(text.status, name).toBe(0)
      expect(text.stdout, name).toContain('no options')
      expect(text.stdout, name).not.toContain(marker)
    }
  })

  it('a command with no options says so instead of printing someone else’s', () => {
    const down = runCli(['down', '--help'])
    expect(down.status).toBe(0)
    expect(down.stdout).toContain('home-hosted down')
    expect(down.stdout).toContain('no options')
    expect(down.stdout).not.toContain('--config')
  })

  it('an unknown command exits 1 with the usage and the old wording', () => {
    const result = runCli(['nonsense'])
    expect(result.status).toBe(1)
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
    expect(typo.status).toBe(1)
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
    expect(noId.status).toBe(1)
    expect(noId.stderr).toContain('needs a server id')

    const noPanel = runCli(['stop', 'web'])
    expect(noPanel.status).toBe(1)
    expect(noPanel.stderr).toContain('home-hosted is not running')
  })

  it('--version prints the package version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
    const result = runCli(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })
})

/**
 * `status` is where an operator looks for a path, and the README says it prints them.
 *
 * Two things worth pinning. It must name the per-server log directory — the panel console's own
 * path is not where a *server's* log lives, and the README's layout table now names the files, so
 * the command that prints paths has to agree. And its label column must stay aligned: it was a
 * literal `padEnd(8)` until a ten-character label was added and pushed every value out of line.
 */
describe('status paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-'))

  it('prints the workspace log directory, aligned, with no running panel', () => {
    const result = runCli(['status', '--home', dir])
    // An unwritten home has no run.json, so this is the "not running" branch — which must still
    // not be an unhandled crash.
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toContain('home-hosted is not running')
  })

  /**
   * "Not running" and "never set up" are different answers, and only one of them needs a next step.
   *
   * A person who has just installed the package runs `status` in an empty directory and was told
   * "home-hosted is not running" — true, unhelpful, and indistinguishable from a panel that *was*
   * set up and has been stopped. The directory has no `workspaces.json`, which is what says whether
   * anything was ever initialised.
   */
  it('tells a never-initialised directory what to do next', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fresh-'))
    try {
      const result = runCli(['status', '--home', empty])
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain('home-hosted is not running')
      // `init` specifically: the *other* branch also offers `up`, so matching either proved nothing
      // (a mutation that always reported "initialised" passed it).
      expect(result.stdout, 'a fresh home must name `init`, not just the running state').toContain('home-hosted init')
    }
    finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('prints every path it documents, aligned, against a real running panel', () => {
    // Spawned for real: `status` reads run.json, so a fixture on disk is the only honest input.
    // A panel is started in the throwaway home and asked for its status.
    const started = runCli(['up', '--home', dir, '--port', '6398', '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const result = runCli(['status', '--home', dir])
      expect(result.status, result.stderr).toBe(0)

      // The per-server log dir — the path an operator needs for a *server's* log, which is not
      // the panel console path printed above it.
      const serverLogs = path.join(dir, '.hh', 'default', '.logs')
      // Printed, not required to exist: the directory appears when a server first writes a log,
      // and a panel that has never run one must still say where they would go.
      expect(result.stdout).toContain(serverLogs)
      // And the console log is still named separately.
      expect(result.stdout).toContain(path.join(dir, '.hh', '.logs', 'home-hosted.log'))

      // Every value starts at the same column. Read the real output rather than recomputing the
      // width, so the assertion is about what the command printed. The labels are wrapped in
      // colour codes, which must go first or the match lands inside them.
      // The invariant is the value's *start column*, not the gap before it: labels are padded to
      // a common width, so the gap legitimately differs per row while the column does not.
      // eslint-disable-next-line no-control-regex
      const plain = result.stdout.replace(/\u001B\[[0-9;]*m/g, '')
      const valueColumns = plain
        .split('\n')
        .map(line => /^ {2}\S+ +/.exec(line)?.[0].length)
        .filter((column): column is number => column !== undefined)
      expect(valueColumns.length, 'no label rows parsed from status').toBeGreaterThan(5)
      expect(new Set(valueColumns).size, `values start at columns ${[...new Set(valueColumns)].join(', ')}`).toBe(1)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })

  /**
   * `home-hosted logs` reads the *panel's* console, not a server's, so `status` is the only place a
   * shell user can learn where a server's own output went. Knowing the directory is not enough —
   * the entry `api` writes `api.log`, and nothing else says so.
   *
   * The convention is shown only when the directory exists: naming a filename pattern for logs that
   * have never been written sends someone looking for a file that is not there.
   */
  it('explains the per-server filename only once there are server logs', () => {
    // Its own home: the tests above share one, and a server log left behind by another case would
    // make the "no convention yet" assertion depend on execution order.
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-convention-'))
    const started = runCli(['up', '--home', own, '--port', '6498', '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const logsDir = path.join(own, '.hh', 'default', '.logs')

      // With no server having run, the path alone is the whole answer.
      const before = runCli(['status', '--home', own])
      expect(before.stdout).toContain(logsDir)
      expect(before.stdout, 'no convention before any log exists').not.toContain('<id>.log')

      // A server having run leaves its file behind; now the naming matters.
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(path.join(logsDir, 'api.log'), '')

      const after = runCli(['status', '--home', own])
      expect(after.stdout).toContain('<id>.log')

      // And the JSON stays a bare path: this is prose for a person, not a field for a script.
      const json = runCli(['status', '--home', own, '--json'])
      expect(JSON.parse(json.stdout).logsDir).toBe(logsDir)
    }
    finally {
      runCli(['down', '--home', own])
      fs.rmSync(own, { recursive: true, force: true })
    }
  })
})

/**
 * `status` has two outputs, and they must name the same paths.
 *
 * The text output gained the per-server log directory when the README's layout table started
 * naming those files; the `--json` output did not, so a script asking for the machine-readable
 * form got `logFile` (the panel console) and nothing for a server's logs. Two renderings of one
 * command are one behaviour, and this pins them together.
 */
describe('status paths in both outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-json-'))

  it('names the per-server log directory in text and in JSON', () => {
    const started = runCli(['up', '--home', dir, '--port', '6497', '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const logsDir = path.join(dir, '.hh', 'default', '.logs')

      const text = runCli(['status', '--home', dir])
      expect(text.stdout).toContain(logsDir)

      const json = runCli(['status', '--home', dir, '--json'])
      const parsed = JSON.parse(json.stdout) as { logsDir?: string, logFile?: string }
      expect(parsed.logsDir).toBe(logsDir)
      // And the console log stays distinct from it, in both.
      expect(parsed.logFile).not.toBe(parsed.logsDir)
      expect(text.stdout).toContain(parsed.logFile!)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })

  /**
   * Every row the text form prints must have a JSON counterpart.
   *
   * Both gaps found here were the same mistake — a field added to one output and not the other:
   * `logsDir` (text only) and `ui` (printed as a row, absent from JSON, so a script could not
   * learn which UI is installed). This pins the specific field that was missing.
   */
  it('reports the installed UI in both outputs', () => {
    const started = runCli(['up', '--home', dir, '--port', '6498', '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)

      const text = runCli(['status', '--home', dir])
      expect(text.stdout, 'the text form has a ui row').toMatch(/^ {2}ui +stock$/m)

      const jsonOut = runCli(['status', '--home', dir, '--json']).stdout
      const parsed = JSON.parse(jsonOut) as { ui?: { custom?: boolean, name?: string } }
      expect(parsed.ui, 'text prints a ui row, so JSON must carry it too').toBeDefined()
      expect(parsed.ui!.custom).toBe(false)
      expect(parsed.ui!.name).toBe('stock')

      // The run.json token authorises a local shutdown, so it must not reach a script's stdout —
      // which is a file, a pipe and often a CI log. A running panel is what makes this meaningful:
      // the other `status --json` fixture has no `run.json`, so it cannot leak one either way.
      const token = (JSON.parse(fs.readFileSync(path.join(dir, '.hh', 'run.json'), 'utf8')) as { token?: string }).token
      expect(token, 'the running panel must have a token, or this proves nothing').toBeTruthy()
      expect(jsonOut, 'the status token must not be printed').not.toContain(token!)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })
})
