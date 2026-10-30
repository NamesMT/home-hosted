import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isWsl } from '#src/providers/wsl-temperature'

/**
 * Whether the WSL2 path can run at all, decided once at module load.
 *
 * `setup-temp --wsl` refuses on a non-WSL host, so a test asserting it *succeeds* can only be right
 * on a WSL2 guest. It was written on one and passed here, then failed on the Linux CI runner — the
 * mirror image of the usual mistake (a test that skips where the code would have run), and the same
 * remedy: gate with `it.runIf` on a condition computed once, never an early `return`, which reports
 * a **pass** for a case that never ran.
 */
const onWsl = isWsl()

/**
 * `setup-temp`'s download flag has **three** states, and one flag expresses all of them.
 *
 * citty reads `--no-X` as negating `--X`, so a boolean *named* `no-download` is unreachable — it just
 * sets `download: false`. The first version added a second flag (`--offline`) to say "never", which
 * was dead weight: leaving `default` off makes the absent case `undefined`, so `undefined` means
 * ask*, `true` means *install*, and `false` (`--no-download`) means *refuse*.
 *
 * This pins the parse, because the difference is invisible in `--help` — all three look like a
 * two-state flag until someone runs them against a script.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

// A scratch home **outside** the repo: writing it into the checkout left an untracked state directory
// that a `git add -A` then committed (`.dev-state-setup-temp-test`), which is the same class as the
// state-in-the-repo rule `AGENTS.md` already forbids for real use.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-setup-temp-'))
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

function run(args: string[], stdin: string): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'setup-temp', ...args], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.stdin.end(stdin)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('setup-temp download flag', () => {
  it('treats --no-download as a refusal, not as an absent flag', async () => {
    // The distinction the whole flag rests on: with `default` omitted, citty gives `undefined` when
    // absent and `false` for `--no-download`. The refusal is observable even on a machine that already
    // has the library, because the message names what is missing — and a machine that has it skips
    // the block entirely, so the assertion is conditional on that.
    const { stdout } = await run(['--wsl', '--no-download'], 'y\n')
    // Whatever is installed, the one thing that must never appear is the prompt: a script that piped
    // `y` in would otherwise install a 6 MB binary nobody asked for.
    expect(stdout).not.toContain('Download it now')
  }, 120_000)

  it('the refusal path is reachable and says where to install', async () => {
    const mod = await import('#src/cli/setup-temp')
    // The flag reaches the runner as a *value*, not as "absent": `false` and `undefined` are different
    // questions, and only the runner can tell them apart.
    expect(mod.setupTempArgs.download).not.toHaveProperty('default')
  })
})

/**
 * A flag the command cannot honour is refused, never silently dropped.
 *
 * `AGENTS.md` states it ("a flag the command cannot honour is refused too"), and it was learned on
 * `restart --workspace <id>`, which used to be ignored. `--download` and `--no-download` are
 * **modifiers of `--wsl`**: the download only happens inside the WSL2 branch, and the no-flag branch
 * ends before any source is chosen. Measured on this machine, each of these exited **0** having done
 * nothing: `setup-temp --download`, `setup-temp --no-download`, and `setup-temp --clear --download`,
 * which printed "no temperature command is set — nothing to clear" under a flag asking for an
 * install. `docs/SERVERS.md` and `--help` both advertise them as if they stood alone.
 *
 * A script that passes `--download` reads exit 0 as "installed" and then finds the tile still `n/a`.
 * The refusal names the flag that is missing, which is the one sentence a script needs.
 */
describe('setup-temp refuses a flag it cannot honour', () => {
  const refusals: Array<{ args: string[], missing: string }> = [
    { args: ['--download'], missing: '--wsl' },
    { args: ['--no-download'], missing: '--wsl' },
    { args: ['--clear', '--download'], missing: '--clear' },
    { args: ['--clear', '--wsl'], missing: '--clear' },
  ]

  it('refuses a download flag with no source to install, instead of exiting 0', async () => {
    for (const { args, missing } of refusals) {
      const result = await run(args, '')
      expect(result.code, `setup-temp ${args.join(' ')} exited 0 having done nothing`).toBe(1)
      // One refusal is one message on one stream, and the whole text goes to stderr.
      expect(result.stderr, `setup-temp ${args.join(' ')} must name ${missing}`).toContain(missing)
      expect(result.stdout, 'a refusal writes nothing to stdout').toBe('')
    }
  }, 120_000)

  it.runIf(onWsl)('still accepts the flags where they mean something', async () => {
    // The refusal must not catch the combination that is the whole point: `--wsl --no-download`.
    // Measured through the real binary, so this cannot pass on a parse alone.
    const result = await run(['--wsl', '--no-download'], '')
    expect(result.code, 'the WSL2 setup path must still run').toBe(0)
    expect(result.stderr).toBe('')
  }, 120_000)
})

/**
 * `--clear` promises to delete the helper, and the CLI cleared only the setting.
 *
 * The help text says "stop using the command and delete the helper", `docs/SERVERS.md` repeats it,
 * and the API's `DELETE /api/host/temperature` does both — but the CLI wrote `tempCommand: ''` and
 * left the script behind. Measured on this WSL2 guest: after `setup-temp --wsl` wrote
 * `/mnt/c/ProgramData/home-hosted/cpu-temp.ps1`, `setup-temp --clear` cleared the config and the file
 * survived, so the panel's own docs described a file it never removed.
 *
 * This runs the real path, so it can only pass on WSL — the same condition the provider's own path
 * tests already carry. Elsewhere the flag still has an answer (there is nothing to delete), which is
 * asserted rather than skipped.
 */
describe('setup-temp --clear deletes the helper it wrote', () => {
  it.runIf(onWsl)('removes the script, not just the setting', async () => {
    const { wslScriptPath } = await import('#src/providers/wsl-temperature')
    const script = wslScriptPath()
    expect(script, 'a WSL2 guest with the Windows drive mounted').not.toBeNull()
    // Set the bridge up for real (the library is already installed on this guest, and
    // `--no-download` refuses to fetch when it is not).
    const setup = await run(['--wsl', '--no-download'], '')
    expect(setup.code, 'the setup itself must succeed for this case to mean anything').toBe(0)
    expect(fs.existsSync(script!), `${script} must exist after setup`).toBe(true)

    const cleared = await run(['--clear'], '')
    expect(cleared.code).toBe(0)
    expect(fs.existsSync(script!), `--clear promises to delete the helper, and ${script} survived`).toBe(false)
  }, 180_000)

  /**
   * The other platform's answer, asserted rather than skipped: there is nothing to delete here, and
   * `--clear` must still be honest about it rather than pretending to have removed a file.
   */
  it.runIf(!onWsl)('clears the setting alone where no helper can exist', async () => {
    // The bridge cannot be installed here, so `--clear` has only the setting to clear — and it must
    // say that, rather than claim to have deleted a helper it never found. This is the sentence a
    // non-WSL user actually reads; the WSL case above proves the deletion.
    const cleared = await run(['--clear'], '')
    expect(cleared.code).toBe(0)
    const said = cleared.stdout + cleared.stderr
    expect(said, 'nothing to clear is the honest answer').toContain('nothing to clear')
    expect(said, 'no helper was found, so none was deleted').not.toContain('deleted')
  }, 60_000)
})
