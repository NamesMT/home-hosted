import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `scripts/dev.mjs` must start from a `PATH` that has neither pnpm nor node on it.
 *
 * It used to die there with a raw stack trace: `spawn pnpm ENOENT` as an unhandled `'error'` event,
 * after printing its banner, so the failure looked like a crash in the middle of a working run.
 * Resolving pnpm beside `process.execPath` was not enough either — pnpm runs its scripts through a
 * shell, and vite/tsx/`build-locales.mjs` all call a bare `node`, so every child exited 127 with
 * `env: 'node': No such file or directory`. Both are fixed by resolving the binary and by putting
 * this node's directory on the child `PATH`.
 *
 * Driven for real under `env -i`, because a `PATH` this test inherits would hide the whole bug.
 */
const repo = process.cwd()
// The node running this test, which is the one `dev.mjs` would run under.
const node = process.execPath
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** A `PATH` with the ordinary system directories and nothing that provides pnpm or node. */
function barePath(): string {
  const nodeDir = path.dirname(node)
  const system = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0 && dir !== nodeDir && !fs.existsSync(path.join(dir, 'pnpm')))
  return system.join(path.delimiter) || '/usr/bin:/bin'
}

/**
 * Run `dev.mjs` with a bare `PATH` and stop it as soon as both children are up.
 *
 * `timeout` kills it on purpose: the script is a supervisor that never exits on its own, so a
 * clean exit is not what "it started" looks like. What matters is the output.
 */
function runDev(args: string[], waitMs = 25_000) {
  const result = spawnSync(node, [path.join(repo, 'scripts/dev.mjs'), ...args], {
    cwd: repo,
    // The pre-builds write `i18n/generated/*.json` inside the repo, which every other worker in a
    // full run reads. Skipping them is what keeps this test from failing the stock suite at random.
    env: { PATH: barePath(), HOME: os.homedir(), HHOSTED_DEV_SKIP_BUILD: '1' },
    encoding: 'utf8',
    timeout: waitMs,
    killSignal: 'SIGTERM',
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

/**
 * Kill whatever is still holding a port the run used.
 *
 * `spawnSync`'s `timeout` signals the child it started, and this script is a *supervisor*: its
 * children (pnpm → tsx → the panel, and pnpm → vite) are separate processes that survive it. Running
 * this test left four panels and UI servers behind on every pass, each holding a port and a scratch
 * home, so the next pass found the port busy — a leaked process is not a cosmetic problem.
 *
 * Matched on the port and the scratch home rather than by pid, because the pids are the grandchildren's
 * and the test never learns them.
 */
function killLeftovers(port: string, home: string): void {
  if (process.platform === 'win32')
    return
  // Two details that each made the first version silently do nothing, so three processes per run
  // kept running while it reported success:
  //  - `pgrep -f 'a|b'` is an extended regular expression, so a pattern built by joining terms finds
  //    nothing;
  //  - a pattern beginning with `--` is parsed as an *option* (`pgrep: unrecognized option`), so it
  //    needs `--` in front of it.
  for (const pattern of [`--port ${port}`, `--home ${home}`]) {
    const found = spawnSync('pgrep', ['-f', '--', pattern], { encoding: 'utf8' })
    for (const pid of (found.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    }
  }
}

describe('scripts/dev.mjs under a PATH with no pnpm and no node', () => {
  it('starts both processes instead of crashing on a spawn it cannot resolve', () => {
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-devpath-'))
    scratch.push(scratchHome)

    // Ports well away from the defaults, so a dev instance the user is running is not disturbed.
    const { stdout, stderr } = runDev([
      '--port',
      '6969',
      '--ui-port',
      '6968',
      '--home',
      scratchHome,
    ])

    killLeftovers('6969', scratchHome)
    killLeftovers('6968', scratchHome)

    // The crash this test exists for: an unhandled spawn error, which node renders as a stack trace.
    expect(stderr, 'a spawn failure must be reported, not thrown').not.toContain('Unhandled \'error\' event')
    expect(stderr, 'no raw ENOENT stack').not.toContain('spawn pnpm ENOENT')
    // The specific failure that survived the first half of the fix.
    expect(stderr, 'no child left without a node on PATH').not.toContain('env: \'node\': No such file or directory')

    // Both children actually reached "I am up", which is what says the resolution worked.
    expect(stdout).toContain('6969')
    expect(stdout).toContain('6968')
    expect(stderr, 'the control plane started').not.toContain('[control] exited with code 127')
    expect(stderr, 'the UI server started').not.toContain('[stock ui] exited with code 127')
  }, 60_000)
})
