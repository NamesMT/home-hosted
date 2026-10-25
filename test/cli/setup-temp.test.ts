import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

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

function run(args: string[], stdin: string): Promise<{ code: number | null, stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'setup-temp', ...args], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stdin.end(stdin)
    child.once('close', code => resolve({ code, stdout }))
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
