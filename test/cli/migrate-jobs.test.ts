import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * `home-hosted migrate` **moves** a 0.15 job into `jobs.config.json`.
 *
 * The docs send a person here after refusing their servers file, so the command has to do the move
 * rather than only stamp a version — a refusal that points at a command which cannot fix it is worse
 * than either.
 *
 * The one dangerous outcome is the one this pins against: a `kind: "job"` entry left in a servers
 * file would be read as a service and its schedule would silently stop firing.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** A home with one workspace whose servers file still declares a job. */
function homeWithJob(extra: Record<string, unknown> = {}): { home: string, servers: string, jobs: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-jobs-'))
  dirs.push(home)
  const workspace = path.join(home, '.hh', 'default')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: 1 },
    workspaces: [{ id: 'default', label: 'Default' }],
    defaultId: 'default',
  }))
  const servers = path.join(workspace, 'servers.config.json')
  fs.writeFileSync(servers, JSON.stringify({
    meta: { writtenBy: 'test', schema: 1 },
    servers: [
      { id: 'web', command: 'node', args: ['server.js'], port: 4000 },
      { id: 'nightly', kind: 'job', schedule: '0 3 * * *', command: './backup.sh', args: ['--full'], label: 'Nightly', ...extra },
    ],
  }))
  return { home, servers, jobs: path.join(workspace, 'jobs.config.json') }
}

describe('migrate, with a job still in the servers file', () => {
  it('moves it to jobs.config.json, keeping what it declared', () => {
    const { home, servers, jobs } = homeWithJob()
    // `HHOSTED_HOME` is set process-wide by the test setup, and it **wins** over `--home` in the
    // child — so it is cleared here, which is exactly what makes this a test of one home.
    const result = runCli(['migrate', '--yes'], { home, env: { HHOSTED_HOME: home } })

    expect(result.output).toContain('moving 1 job(s)')
    const moved = JSON.parse(fs.readFileSync(jobs, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    expect(moved.jobs).toHaveLength(1)
    expect(moved.jobs[0]).toMatchObject({ id: 'nightly', schedule: '0 3 * * *', command: './backup.sh', args: ['--full'], label: 'Nightly' })

    // And the servers file is a servers file again: the job left, the service stayed.
    const after = JSON.parse(fs.readFileSync(servers, 'utf8')) as { servers: Array<Record<string, unknown>> }
    expect(after.servers.map(entry => entry.id)).toEqual(['web'])
    expect(after.servers[0]).not.toHaveProperty('kind')
  })

  it('keeps a .bak of the file it rewrites, as the command promises', () => {
    const { home, servers } = homeWithJob()
    runCli(['migrate', '--yes'], { home, env: { HHOSTED_HOME: home } })
    // The servers file is the one rewritten. `jobs.config.json` did not exist, so there is nothing to
    // keep a copy **of** — a `.bak` of an absent file would be an empty promise.
    expect(fs.existsSync(`${servers}.bak`), 'the servers file it rewrote').toBe(true)
  })

  it('says what it would do, and writes nothing, with --dry-run', () => {
    const { home, servers, jobs } = homeWithJob()
    const before = fs.readFileSync(servers, 'utf8')
    const result = runCli(['migrate', '--dry-run'], { home, env: { HHOSTED_HOME: home } })

    expect(result.output).toContain('moving 1 job(s)')
    expect(result.output).toContain('nothing was written')
    expect(fs.readFileSync(servers, 'utf8')).toBe(before)
    expect(fs.existsSync(jobs)).toBe(false)
  })

  /**
   * A move is a change, so the summary must count it.
   *
   * The summary counted only schema files, so a home whose sole pending work was a `kind: "job"`
   * entry printed "moving 1 job(s)…", then the move, then "every file is already what home-hosted X
   * understands — nothing to migrate" — the last line a person reads, contradicting the two above it
   * and implying the command had done nothing and wanted re-running.
   */
  it('counts a moved job in its summary, rather than saying there was nothing to do', () => {
    const { home } = homeWithJob()

    const real = runCli(['migrate', '--yes'], { home, env: { HHOSTED_HOME: home } })
    expect(real.output).toContain('moved 1 job(s)')
    expect(real.output).not.toContain('nothing to migrate')
    expect(real.output).toContain('1 job(s) moved')
  })

  it('counts a job a dry run would move, rather than saying there was nothing to do', () => {
    const { home } = homeWithJob()

    const rehearsal = runCli(['migrate', '--dry-run'], { home, env: { HHOSTED_HOME: home } })
    expect(rehearsal.output).toContain('1 job(s) would be moved')
    expect(rehearsal.output).not.toContain('nothing to migrate')
  })

  it('leaves a home with no jobs alone', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-nojobs-'))
    dirs.push(home)
    const workspace = path.join(home, '.hh', 'default')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), JSON.stringify({
      meta: { writtenBy: 'test', schema: 1 },
      workspaces: [{ id: 'default', label: 'Default' }],
      defaultId: 'default',
    }))
    fs.writeFileSync(path.join(workspace, 'servers.config.json'), JSON.stringify({
      meta: { writtenBy: 'test', schema: 1 },
      servers: [{ id: 'web', command: 'node', port: 4000 }],
    }))

    const result = runCli(['migrate', '--yes'], { home, env: { HHOSTED_HOME: home } })
    expect(result.output).not.toContain('moving')
    expect(fs.existsSync(path.join(workspace, 'jobs.config.json'))).toBe(false)
  })
})
