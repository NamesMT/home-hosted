import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * `logs --json` has two shapes, and both are a promise to a script.
 *
 * `AGENTS.md` and `docs/CLI.md` both state it: one-shot `--json` prints **one document**, while
 * `--follow --json` prints **one object per line** — NDJSON — because a stream has no single document
 * to print, each line `{ path, line }`. The code says the same thing in two places.
 *
 * Nothing tested either shape. Verified by hand against a live panel first: `logs --follow --json`
 * emitted six lines, each parsing independently with exactly `{ path, line }` and no array wrapper, and
 * `usage --json` (a command that needs a running panel) printed **nothing** on stdout with one message
 * on stderr and exit 1. This pins both, because a wrapper added "for consistency" would break every
 * consumer silently — a stream reader cannot look ahead for a closing bracket.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** A home with a panel log already on disk, which is all `logs` reads. */
function homeWithLog(lines: string[]): { home: string, log: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-logs-json-'))
  dirs.push(home)
  const logs = path.join(home, '.hh', '.logs')
  fs.mkdirSync(logs, { recursive: true })
  const log = path.join(logs, 'home-hosted.log')
  fs.writeFileSync(log, lines.map(line => `${line}\n`).join(''))
  return { home, log }
}

describe('the CLI\'s machine-readable output', () => {
  it('prints one document for a one-shot --json', () => {
    const { home, log } = homeWithLog(['first', 'second'])

    const result = runCli(['logs', '--json'], { home })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // One document: the whole of stdout parses as a single value.
    const parsed = JSON.parse(result.stdout) as { path: string, lines: string[] }
    expect(parsed.path).toBe(log)
    expect(parsed.lines).toEqual(['first', 'second'])
  })

  it('prints NDJSON, one { path, line } per line, when following', async () => {
    const { home, log } = homeWithLog(['one', 'two', 'three'])

    /**
     * `--follow` never exits on its own, so this uses the async spawn with a deadline rather than
     * `runCli`'s synchronous one. Three lines are already on disk, so the read returns immediately and
     * the budget is only a safety net.
     */
    const { stdout } = await followFor(['logs', '--follow', '--json'], home, 6000)

    const lines = stdout.split('\n').filter(line => line.length > 0)
    expect(lines.length, `no NDJSON lines were printed — stdout was ${JSON.stringify(stdout.slice(0, 120))}`).toBeGreaterThan(0)

    for (const line of lines) {
      // Each line stands alone. A wrapper array would make this throw on the first one.
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(Object.keys(parsed).sort(), 'every line carries exactly `path` and `line`').toEqual(['line', 'path'])
      expect(parsed.path).toBe(log)
      expect(typeof parsed.line).toBe('string')
    }
    // And no line is a bare `[` or `]` from an array wrapper.
    expect(lines.some(line => line.trim() === '[' || line.trim() === ']')).toBe(false)
  })

  it('prints nothing on stdout and one message on stderr when a command refuses', () => {
    // `usage` needs a running panel; with none, the contract is a refusal rather than an empty document.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-logs-none-'))
    dirs.push(home)

    const result = runCli(['usage', '--json'], { home })
    expect(result.status, 'a refusal must exit non-zero').not.toBe(0)
    expect(result.stdout, 'a refused --json must print no document').toBe('')
    expect(result.stderr.trim().length, 'a refusal says why').toBeGreaterThan(0)
    // One message, not a stack trace.
    expect(result.stderr).not.toContain('    at ')
  })
})

/** Run the CLI asynchronously until `deadlineMs` passes, then return what it printed. */
async function followFor(args: string[], home: string, deadlineMs: number): Promise<{ stdout: string, stderr: string }> {
  const { spawn } = await import('node:child_process')
  const { cliArgv } = await import('../support/run-cli')
  const [executable, ...argv] = cliArgv(args, home)

  return new Promise((resolve) => {
    const child = spawn(executable, argv, { env: { ...process.env, HHOSTED_HOME: home } })
    let stdout = ''
    let stderr = ''
    // Declared before `finish` reads it: the deadline can fire while the handler is being defined.
    let timer: NodeJS.Timeout | undefined
    const finish = (): void => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve({ stdout, stderr })
    }
    // The three lines are already on disk, so a follow returns them at once; waiting out the deadline
    // would cost six seconds per run for nothing.
    timer = setTimeout(finish, deadlineMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.split('\n').filter(line => line.length > 0).length >= 3)
        finish()
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('exit', finish)
  })
}
