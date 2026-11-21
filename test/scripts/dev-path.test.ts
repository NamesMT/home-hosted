import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { testPort } from '../support/ports'

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

/**
 * A `PATH` with node's own directory **and every other pnpm** removed.
 *
 * The point of the case is narrow and worth stating: `resolvePnpm()` looks for pnpm *beside the node
 * running the script*, so the test must take that directory away and prove the script still finds the
 * binary by the route it declares. It must **not** remove every directory holding a pnpm, which is what
 * the first version did — on the macOS runner pnpm is a standalone binary on `PATH` with nothing beside
 * node, so the filter stripped its only home and the test failed there while passing on a developer
 * machine whose version manager keeps pnpm beside node. A test that only passes on one install layout
 * is testing the layout, not the code.
 *
 * If this machine has no pnpm beside node either, there is nothing to prove and the case skips.
 */
function pathWithoutPnpm(): string | null {
  const nodeDir = path.dirname(node)
  if (!fs.existsSync(path.join(nodeDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')))
    return null
  const rest = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(dir => dir.length > 0 && dir !== nodeDir)
  return rest.join(path.delimiter) || '/usr/bin:/bin'
}

/**
 * Run `dev.mjs` with a bare `PATH` and stop it as soon as both children are up.
 *
 * `timeout` kills it on purpose: the script is a supervisor that never exits on its own, so a
 * clean exit is not what "it started" looks like. What matters is the output.
 */
/**
 * Run `dev.mjs` until both children have said they are up, then stop it.
 *
 * `dev.mjs` is a supervisor and never exits on its own, so a fixed `spawnSync` timeout was the only
 * bound — and that value decided pass-or-flake: 25 s was plenty alone and not enough under a full
 * parallel run, where 364 workers share the CPU. Waiting longer would make every healthy run pay the
 * whole budget, so this watches the output instead and returns as soon as both signals have appeared
 * (`Listening on` from the panel, `ready in` from vite), with `deadlineMs` as the ceiling for a run
 * that never gets there.
 */
interface DevRun { stdout: string, stderr: string, status: number | null }

function runDev(args: string[], searchPath: string, deadlineMs = 120_000): Promise<DevRun> {
  return new Promise((resolve) => {
    const child = spawn(node, [path.join(repo, 'scripts/dev.mjs'), ...args], {
      cwd: repo,
      // The pre-builds write `i18n/generated/*.json` inside the repo, which every other worker in a
      // full run reads. Skipping them is what keeps this test from failing the stock suite at random.
      env: { PATH: searchPath, HOME: os.homedir(), HHOSTED_DEV_SKIP_BUILD: '1' },
    })
    const out = { stdout: '', stderr: '' }
    // Declared before `settle` reads it: the deadline can fire while the handler is being defined.
    let timer: NodeJS.Timeout | undefined
    const settle = (status: number | null) => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      // The grandchildren outlive a kill on the direct child; the caller clears them by port.
      resolve({ ...out, status })
    }
    timer = setTimeout(settle, deadlineMs, null)
    const watch = () => {
      if (out.stdout.includes('Listening on') && out.stdout.includes('ready in'))
        settle(0)
    }
    child.stdout.on('data', (chunk) => {
      out.stdout += String(chunk)
      watch()
    })
    child.stderr.on('data', (chunk) => {
      out.stderr += String(chunk)
    })
    child.on('exit', code => settle(code))
  })
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

describe('scripts/dev.mjs finds pnpm without it being on PATH', () => {
  /**
   * Skipped rather than faked where it cannot be exercised: an install layout with no pnpm beside node
   * has nothing for the resolution to find, and inventing a binary to look at would test the fixture.
   */
  const strippedPath = pathWithoutPnpm()

  it.skipIf(strippedPath === null)('starts both processes instead of crashing on a spawn it cannot resolve', async () => {
    // `it.skipIf` narrows nothing for the compiler, so say it once here rather than casting below.
    if (strippedPath === null)
      throw new Error('unreachable: the case is skipped without a pnpm beside node')
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-devpath-'))
    scratch.push(scratchHome)

    /**
     * Ports from this worker's own block, not fixed ones.
     *
     * Hardcoded 6968/6969 collided with a panel another run had left behind, and the run then failed
     * with `Port 6968 is already in use` — which looked like the resolution being broken. The helper
     * hands out a block no other worker and no `listen(0)` can land on, so the case tests the thing it
     * names.
     */
    const panelPort = String(await testPort())
    const uiPort = String(await testPort())
    const { stdout, stderr } = await runDev([
      '--port',
      panelPort,
      '--ui-port',
      uiPort,
      '--home',
      scratchHome,
    ], strippedPath)

    killLeftovers(panelPort, scratchHome)
    killLeftovers(uiPort, scratchHome)

    // The crash this test exists for: an unhandled spawn error, which node renders as a stack trace.
    expect(stderr, 'a spawn failure must be reported, not thrown').not.toContain('Unhandled \'error\' event')
    expect(stderr, 'no raw ENOENT stack').not.toContain('spawn pnpm ENOENT')
    // The specific failure that survived the first half of the fix.
    expect(stderr, 'no child left without a node on PATH').not.toContain('env: \'node\': No such file or directory')

    /**
     * Both children reached "I am up". Asserting only on specific exit codes was not enough: a run
     * where the UI child died of `Port 6968 is already in use` still satisfied the earlier checks,
     * because the banner prints the port numbers optimistically and the failure was a code other
     * than 127. What says the resolution worked is that **neither** child exited at all before the
     * timeout — a started Vite says "ready in", and a started panel says "listening".
     */
    expect(stdout).toContain(panelPort)
    expect(stdout).toContain(uiPort)
    // The positive signals each child prints when it is actually serving. Asserting these rather than
    // the absence of one exit code: a run whose UI child died of `Port 6968 is already in use` printed
    // the banner (which names both ports optimistically) and exited with a code the old check did not
    // name, so it passed while half the command had not started.
    expect(stdout, 'the panel never started listening').toContain('Listening on')
    expect(stdout, 'vite never became ready').toContain('ready in')
  }, 150_000)

  /**
   * `--help` answers immediately, without building or binding anything.
   *
   * Every unrecognised flag is passed through to `up`, which is right for `--log-level` and `--bind`.
   * `--help` in that position reached the panel, and the panel answered it *after* both servers were
   * up: measured, `pnpm dev --help` built the stock UI and bound 6950/6951 before printing a word. A
   * person asking what the command does got a dev server on two ports — and on the default ports, that
   * is someone's running panel being disturbed.
   *
   * The assertion that matters is the **absence of a build banner**: it is printed before anything is
   * spawned, so if help is still being passed through, it appears.
   */
  it('prints its usage for --help and starts nothing', () => {
    // Help must work on a `PATH` with no pnpm too — it is the answer to "why did this not run".
    const bare = pathWithoutPnpm() ?? (process.env.PATH ?? '/usr/bin:/bin')
    for (const flag of ['--help', '-h']) {
      const result = spawnSync(node, [path.join(repo, 'scripts', 'dev.mjs'), flag], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: bare, HOME: os.tmpdir() },
      })

      expect(result.status, `${flag} must exit cleanly — stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout, `${flag} must say what the command does`).toContain('pnpm dev')
      expect(result.stdout, `${flag} must name the flags`).toContain('--ui-port')
      expect(
        result.stdout,
        `${flag} started building the UI instead of answering — the flag reached the panel`,
      ).not.toContain('building the stock UI')
    }
  }, 90_000)
})
