import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * A person pipes the CLI into `head`, `grep -q`, or an agent's reader that stops early — the ordinary
 * shell habit, and what a deploy script does to take the first line of `status`.
 *
 * Node's stdout is a socket: when a reader closes it, the next write raises `EPIPE` as an **error
 * event**, and an unhandled one kills the process with an engine stack trace and exit 1. Measured on
 * the built CLI: `dist/cli.js status | head -1` printed `Error: write EPIPE … at runStatus` and exited
 * 1, so `set -o pipefail` turned a working panel into a failed deploy step.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-epipe-'))

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

/** A console log big enough that a reader quitting after one line leaves bytes unread. */
function bigLog(): string {
  const dir = path.join(home, '.hh', '.logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'home-hosted.log')
  fs.writeFileSync(file, `${Array.from({ length: 20_000 }, (_, index) => `line ${index} ${'x'.repeat(80)}`).join('\n')}\n`)
  return file
}

/** Runs the CLI with its stdout piped to a reader that closes after `keep` bytes. */
function runPiped(args: string[], keep: number): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    let seen = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      seen += chunk.length
      // The reader is done: this is `head -1` hanging up.
      if (seen >= keep)
        child.stdout.destroy()
    })
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('a reader that hangs up early', () => {
  it('exits quietly instead of dying of an unhandled EPIPE', async () => {
    bigLog()
    const result = await runPiped(['logs', '--lines', 'all'], 200)
    expect(result.stderr).not.toContain('EPIPE')
    expect(result.stderr).not.toContain('Unhandled')
    expect(result.code).toBe(0)
  })
})
