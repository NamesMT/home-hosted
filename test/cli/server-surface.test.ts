import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The CLI surface an operator and a script actually use: one server's log, the usage table, and the
 * two honesty fixes around a start that dies and a `down` with no record to go on.
 *
 * Each of these came from a review round that measured the failure, so each test asserts the
 * observable symptom rather than the sentence.
 */

const dirs: string[] = []

/** A state root with one workspace and one entry whose log is already on disk. */
function stateRoot(options: { workspace?: string, serverId?: string, logLines?: string[] } = {}): { home: string, logPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cli-surface-'))
  dirs.push(home)
  const workspace = options.workspace ?? 'default'
  const id = options.serverId ?? 'web'
  const logsDir = path.join(home, '.hh', workspace, '.logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${id}.log`)
  fs.writeFileSync(logPath, `${(options.logLines ?? []).join('\n')}\n`)
  return { home, logPath }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** Runs `runLogs` with both streams captured, so a test can assert which one was used. */
async function captureLogs(home: string, input: Parameters<typeof import('#src/cli/logs').runLogs>[0]): Promise<{ stdout: string, stderr: string }> {
  process.env.HHOSTED_HOME = home
  vi.resetModules()
  const { runLogs } = await import('#src/cli/logs')
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
  try {
    await runLogs(input)
  }
  finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
  return { stdout: out.join(''), stderr: err.join('') }
}

describe('logs <id>', () => {
  /**
   * A server's log is JSONL, so the human form has to render it — printing the stored bytes shows a
   * person a JSON object per line where the panel shows them a log.
   */
  it('renders a stored server log as text, not as JSON', async () => {
    const { home } = stateRoot({
      logLines: [
        '{"ts":1,"stream":"system","text":"start: node server.js"}',
        '{"ts":2,"stream":"stdout","text":"listening on 3000"}',
      ],
    })

    const { stdout } = await captureLogs(home, { id: 'web' })

    expect(stdout).toContain('start: node server.js')
    expect(stdout).toContain('listening on 3000')
    // The raw record must not leak into the human form.
    expect(stdout).not.toContain('"ts":1')
  })

  /** `--json` hands back what is stored, so a consumer parses the same records the panel wrote. */
  it('keeps the stored records intact under --json', async () => {
    const { home, logPath } = stateRoot({ logLines: ['{"ts":1,"stream":"system","text":"hello"}'] })

    const { stdout } = await captureLogs(home, { id: 'web', json: true })
    const parsed = JSON.parse(stdout) as { path: string, lines: string[] }

    expect(parsed.path).toBe(logPath)
    expect(parsed.lines[0]).toBe('{"ts":1,"stream":"system","text":"hello"}')
  })

  /**
   * A server id is only unique inside a workspace, so `--workspace` has to reach the right file.
   * Reading the default one instead would print another server's output under this name.
   */
  it('reads the workspace it was told, not the default one', async () => {
    const { home } = stateRoot({ workspace: 'staging', serverId: 'api', logLines: ['{"ts":1,"stream":"stdout","text":"from staging"}'] })
    // A same-named entry in the default workspace, so a wrong lookup would still find a file.
    const defaultDir = path.join(home, '.hh', 'default', '.logs')
    fs.mkdirSync(defaultDir, { recursive: true })
    fs.writeFileSync(path.join(defaultDir, 'api.log'), '{"ts":9,"stream":"stdout","text":"from default"}\n')

    const { stdout } = await captureLogs(home, { id: 'api', workspace: 'staging' })

    expect(stdout).toContain('from staging')
    expect(stdout).not.toContain('from default')
  })
})

describe('status --json liveness', () => {
  /**
   * The README promises `liveness` on every `--json` answer, but a home with no `run.json` omitted
   * it — so a script branching on it had to special-case "no record at all" separately. No record
   * is not "unknown": nothing is behind the pid, which is exactly `gone`.
   */
  it('carries liveness even when there is no run.json to describe', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-liveness-'))
    dirs.push(home)
    // `workspaces.json` is what makes this "initialised but stopped" rather than "never set up".
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), '{"meta":{},"workspaces":[]}\n')

    process.env.HHOSTED_HOME = home
    vi.resetModules()
    const { runStatus } = await import('#src/cli/status')
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      await runStatus(true)
    }
    finally {
      spy.mockRestore()
    }

    const parsed = JSON.parse(out.join('')) as { running: boolean, initialised: boolean, liveness?: string }
    expect(parsed.running).toBe(false)
    expect(parsed.initialised).toBe(true)
    expect(parsed.liveness, 'liveness is part of the documented contract').toBe('gone')
  })
})
