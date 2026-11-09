import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { homeFingerprint } from '#src/helpers/paths'

/**
 * The CLI surface an operator and a script actually use: one server's log, the usage table, and the
 * two honesty fixes around a start that dies and a `down` with no record to go on.
 *
 * Each of these came from a review round that measured the failure, so each test asserts the
 * observable symptom rather than the sentence.
 */

const dirs: string[] = []
/** Real listeners a test opened — closed afterwards, whatever the assertions did. */
const listeners: http.Server[] = []

/** A state root with one workspace and one entry whose log is already on disk. */
function stateRoot(options: {
  workspace?: string
  serverId?: string
  logLines?: string[]
  /** The entries `servers.config.json` declares; `null` writes no config file at all. */
  declares?: string[] | null
} = {}): { home: string, logPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cli-surface-'))
  dirs.push(home)
  const workspace = options.workspace ?? 'default'
  const id = options.serverId ?? 'web'
  const logsDir = path.join(home, '.hh', workspace, '.logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${id}.log`)
  fs.writeFileSync(logPath, `${(options.logLines ?? []).join('\n')}\n`)
  const declares = options.declares === undefined ? [id] : options.declares
  if (declares !== null) {
    fs.writeFileSync(
      path.join(home, '.hh', workspace, 'servers.config.json'),
      `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, servers: declares.map(entry => ({ id: entry, command: 'node' })) }, null, 2)}\n`,
    )
  }
  return { home, logPath }
}

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
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

  /**
   * With no `--workspace`, the workspace is the panel's default — the **registry's** rule
   * (`default`, or the first it lists), not the literal id `default`.
   *
   * A host that declares `["media"]` — a colleague's panel, or one whose `default` was removed —
   * resolves an omitted `?workspace` to `media` in the panel, so `start sonarr` reached
   * `media/sonarr` while `logs sonarr` looked in `.hh/default/.logs/sonarr.log`. Measured on a live
   * panel of that shape: `logs` answered "no output yet" and exited 0 for a log that was on disk,
   * on the first command a diagnostic session runs. The two commands disagreed about what
   * "default" means.
   */
  it('defaults to the workspace the panel defaults to, not the literal `default`', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cli-surface-'))
    dirs.push(home)
    fs.mkdirSync(path.join(home, '.hh', 'media', '.logs'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.hh', 'media', '.logs', 'sonarr.log'),
      '{"ts":1,"stream":"stdout","text":"the real log"}\n',
    )
    fs.writeFileSync(
      path.join(home, '.hh', 'workspaces.json'),
      `${JSON.stringify({ meta: { writtenBy: '0.11.0', schema: 1 }, workspaces: [{ id: 'media', label: 'Media' }] }, null, 2)}\n`,
    )

    const { stdout, stderr } = await captureLogs(home, { id: 'sonarr' })

    expect(stderr).toBe('')
    expect(stdout).toContain('the real log')
    expect(stdout).not.toContain(path.join('.hh', 'default', '.logs', 'sonarr.log'))
  })

  /**
   * A typo must not answer like an empty log.
   *
   * Measured on a running panel, a typo and a live id side by side: `logs webx` printed
   * `no output yet — …/webx.log` and exited **0**, while `start webx`/`stop webx` refused the same
   * id. So a diagnostic session's first command agreed with a typo, and `logs webx | grep -q error`
   * was a silently empty pipeline that reads as "no errors".
   *
   * The refusal belongs on stderr with a non-zero exit, like every other refusal here. `--json` gets
   * no document at all: `{ lines: [] }` is exactly the empty success this guards against.
   */
  it('refuses an id the workspace does not declare, instead of reporting an empty log', async () => {
    const { home } = stateRoot({ serverId: 'web', logLines: ['{"ts":1,"stream":"stdout","text":"hi"}'] })

    const { stdout, stderr } = await captureLogs(home, { id: 'webx' })

    expect(process.exitCode, 'a refusal that keeps its answer would still be a success').toBe(1)
    expect(stdout, 'stdout carries only an answer, and there is none').toBe('')
    expect(stderr).toContain('unknown server "webx"')
    // It names the near miss, which is the whole point of reading the config for this.
    expect(stderr).toContain('web')

    const json = await captureLogs(home, { id: 'webx', json: true })
    expect(json.stdout, '`{ lines: [] }` is the empty success this refusal exists to stop').toBe('')

    process.exitCode = 0
  })

  /**
   * A log outlives the entry that wrote it, and reading it is the one case the config cannot decide.
   *
   * This is why the row was open rather than a one-line fix: refusing on the config alone would make
   * the log of a removed server unreadable — the log a person is most likely to want. The file is
   * read as before; the note on stderr stops "this server has written nothing" from being the
   * conclusion.
   */
  it('still reads the log of a removed entry, saying the entry is gone', async () => {
    const { home, logPath } = stateRoot({ serverId: 'web', logLines: ['{"ts":1,"stream":"stdout","text":"left behind"}'], declares: [] })

    const { stdout, stderr } = await captureLogs(home, { id: 'web' })

    expect(process.exitCode).toBe(0)
    expect(stdout).toContain('left behind')
    expect(stdout).toContain(logPath)
    expect(stderr).toContain('not in servers.config.json')
  })

  /**
   * "I cannot tell" is not "there is no such entry".
   *
   * A config this release cannot parse, or a home that has none, is exactly what a diagnostic
   * command meets. Refusing there would turn a readable log into an error, so the command answers as
   * it always did — and reading a log never writes a seed config into the home it was reading.
   */
  it('answers as before when the workspace config cannot say', async () => {
    const noConfig = stateRoot({ serverId: 'web', declares: null })
    expect((await captureLogs(noConfig.home, { id: 'anything' })).stdout).toContain('no output yet')
    expect(fs.existsSync(path.join(noConfig.home, '.hh', 'default', 'servers.config.json')), 'reading a log must not seed a config').toBe(false)

    const broken = stateRoot({ serverId: 'web' })
    fs.writeFileSync(path.join(broken.home, '.hh', 'default', 'servers.config.json'), '{ broken')
    const answer = await captureLogs(broken.home, { id: 'anything' })
    expect(answer.stdout).toContain('no output yet')
    expect(answer.stderr).toBe('')
  })

  /**
   * The same false answer, one level up: a `--workspace` that names nothing.
   *
   * `logs web -w typo` joined the id into a path and read a file that could not exist, so it printed
   * `no output yet — …/.hh/typo/.logs/web.log` and exited **0** — while `start web -w typo` refused
   * the same id. `logs web -w typo | grep -q error` was therefore an empty pipeline that reads as
   * "no errors", on the first command a diagnostic session runs.
   */
  it('refuses a --workspace that names no workspace', async () => {
    const { home } = stateRoot({ serverId: 'web', logLines: ['{"ts":1,"stream":"stdout","text":"hi"}'] })
    fs.writeFileSync(
      path.join(home, '.hh', 'workspaces.json'),
      `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`,
    )

    const { stdout, stderr } = await captureLogs(home, { id: 'web', workspace: 'typo' })

    expect(process.exitCode, 'a refusal that keeps its answer would still be a success').toBe(1)
    expect(stdout, 'stdout carries only an answer, and there is none').toBe('')
    expect(stderr).toContain('unknown workspace "typo"')

    // ...and a workspace that does exist still reads, with no note on stderr.
    process.exitCode = 0
    const ok = await captureLogs(home, { id: 'web', workspace: 'default' })
    expect(process.exitCode).toBe(0)
    expect(ok.stdout).toContain('hi')
    expect(ok.stderr).toBe('')
  })

  /**
   * A registry that parses but lists nothing is "I cannot tell", not "no workspace exists".
   *
   * `readDefaultWorkspaceId` — the sibling in the same file — falls back to `default` for an empty
   * registry, because that is what a hand-edit or a partially written file looks like, and that is
   * the workspace the panel serves. Reading the ids as `[]` refused it: `logs web` on such a home
   * exited 1 with `unknown workspace "default"`, while `start web` acted on it. Two rules in one file
   * is the drift this whole change exists to remove.
   */
  it('does not refuse the default workspace when the registry lists none', async () => {
    const { home } = stateRoot({ serverId: 'web', logLines: ['{"ts":1,"stream":"stdout","text":"hi"}'] })
    fs.writeFileSync(
      path.join(home, '.hh', 'workspaces.json'),
      `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, workspaces: [] }, null, 2)}\n`,
    )

    const { stdout, stderr } = await captureLogs(home, { id: 'web' })

    expect(process.exitCode, 'an empty registry must not turn a readable log into a refusal').toBe(0)
    expect(stdout).toContain('hi')
    expect(stderr).toBe('')
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

describe('status --json exitedCleanly', () => {
  /**
   * A clean `down` and a crash both leave no `run.json`, because `up` tidies the record a crash left
   * behind. So absence could not tell "I stopped it" from "it died", and a script had to infer it
   * from which keys happened to be missing. A deliberate stop records `exitedCleanly` instead.
   */
  it('reports a deliberate stop as clean, and a tidied crash as not', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-exited-cleanly-'))
    dirs.push(home)
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), '{"meta":{},"workspaces":[]}\n')

    const read = async (): Promise<{ exitedCleanly?: boolean, lastStopAt?: number }> => {
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
      return JSON.parse(out.join('')) as { exitedCleanly?: boolean, lastStopAt?: number }
    }

    // Nothing has ever stopped this panel.
    expect((await read()).exitedCleanly).toBe(false)
    expect((await read()).lastStopAt).toBeUndefined()

    // A deliberate stop records it.
    const { recordCleanStop } = await import('#src/helpers/last-stop')
    recordCleanStop(1_700_000_000_000)
    const clean = await read()
    expect(clean.exitedCleanly).toBe(true)
    expect(clean.lastStopAt).toBe(1_700_000_000_000)

    fs.rmSync(path.join(home, '.hh', '.last-stop.json'), { force: true })
  })
})

describe('status with no run.json but a panel still answering', () => {
  /**
   * A record is not the machine, and `status` is the command that forgot it.
   *
   * Measured on a live panel: deleting `.hh/run.json` made `status` print "home-hosted is not
   * running" and exit 1 while `GET /healthz` on the very port it names in `settings.json` answered
   * 200 — so a diagnostic session's first command denied the panel being diagnosed. `down` had
   * already learned this shape and refuses; the same probe answers here.
   *
   * It must stay a probe: no pid is reported and nothing is signalled, because without a record
   * there is no process this command can prove it owns.
   */
  it('says something is answering, and refuses to pretend it knows what', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-answering-'))
    dirs.push(home)
    // A real listener, because the claim under test is about the machine: a stub would only prove
    // that `probePort` was called.
    // Which home the stand-in claims: only a panel naming *this* home is this home's panel.
    let claims: string | null = homeFingerprint(home)
    const server = http.createServer((_req, res) => {
      res.end(JSON.stringify({ status: 'ok', uptimeMs: 1, ...(claims === null ? {} : { home: claims }) }))
    })
    listeners.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), '{"meta":{},"workspaces":[]}\n')
    fs.writeFileSync(
      path.join(home, '.hh', 'settings.json'),
      `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, control: { port, host: 'local' } }, null, 2)}\n`,
    )

    const read = async (json: boolean): Promise<{ stdout: string, stderr: string }> => {
      process.env.HHOSTED_HOME = home
      vi.resetModules()
      const { runStatus } = await import('#src/cli/status')
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
        await runStatus(json)
      }
      finally {
        outSpy.mockRestore()
        errSpy.mockRestore()
      }
      return { stdout: out.join(''), stderr: err.join('') }
    }

    const text = await read(false)
    // Exit 1 still: `running` is a claim about the record, and there is no record.
    expect(process.exitCode, 'no record, so `running: false` and exit 1').toBe(1)
    expect(text.stdout, 'the sentence must not deny a panel that is serving').not.toMatch(/is not running —/)
    expect(text.stdout).toContain(`127.0.0.1:${port}`)
    // Nothing is named that this command cannot prove, and nothing is signalled.
    expect(text.stdout).not.toMatch(/pid \d/)

    const json = JSON.parse((await read(true)).stdout) as { running: boolean, answeringWithoutRecord?: string }
    expect(json.running).toBe(false)
    expect(json.answeringWithoutRecord).toBe(`http://127.0.0.1:${port}`)
    expect(server.listening, 'status probes; it never signals').toBe(true)

    // Another home's panel on the same port is not this one: the port is reported taken, not "ours".
    claims = 'another-home'
    const other = JSON.parse((await read(true)).stdout) as { answeringWithoutRecord?: string, portTakenByOther?: number }
    expect(other.answeringWithoutRecord).toBeUndefined()
    expect(other.portTakenByOther).toBe(port)
    expect((await read(false)).stdout).toContain(`port ${port} is taken by another process`)

    // And with nothing on that port, the original sentence is unchanged.
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.exitCode = 0
    const quiet = await read(true)
    expect(JSON.parse(quiet.stdout).answeringWithoutRecord).toBeUndefined()
  })
})
