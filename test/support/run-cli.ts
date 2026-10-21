import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Running the TypeScript CLI from a test, the one way that works on every platform.
 *
 * `node_modules/.bin/tsx` is a `#!/bin/sh` shim. Linux and macOS hand it to the shell; Windows
 * cannot — what it has there is `tsx.cmd`/`tsx.ps1`, so `execFile` on the POSIX script starts nothing
 * and the test reads empty streams. The failure then names the output (`expected '' to match …`)
 * rather than the launcher, and only on the Windows runner.
 *
 * Node runs the loader itself instead. `process.execPath` is an executable everywhere, and
 * `--import=tsx` resolves from this repository's own `node_modules` — which is why the child's `cwd`
 * is the repository root, not the caller's.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const cli = path.join(root, 'src', 'cli.ts')

export interface CliRun {
  status: number | null
  stdout: string
  stderr: string
  /** `stdout` then `stderr`, colour-free — a failure may put its reason on either one. */
  output: string
}

export interface CliRunOptions {
  /** Passed as `--home` and `HHOSTED_HOME`, so nothing reads the real state directory. */
  home?: string
  env?: Record<string, string | undefined>
  /** Bounds a hung child; a sync spawn cannot be interrupted by the test's own timeout. */
  timeout?: number
}

/** The executable and its arguments — exported so a test can pin what is spawned and how. */
export function cliArgv(args: string[], home?: string): [executable: string, ...argv: string[]] {
  return [
    process.execPath,
    '--import=tsx',
    cli,
    ...(home === undefined ? [] : ['--home', home]),
    ...args,
  ]
}

/** Runs `home-hosted <args>` and returns what it printed. A non-zero exit is data, not a throw. */
export function runCli(args: string[], options: CliRunOptions = {}): CliRun {
  const [executable, ...argv] = cliArgv(args, options.home)
  const result = spawnSync(executable, argv, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    env: {
      ...process.env,
      ...(options.home === undefined ? {} : { HHOSTED_HOME: options.home }),
      ...options.env,
    },
  })
  const stdout = plain(result.stdout ?? '')
  const stderr = plain(result.stderr ?? '')
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` }
}

/** A piped child prints no colour; stripping anyway keeps an assertion from matching inside one. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}
