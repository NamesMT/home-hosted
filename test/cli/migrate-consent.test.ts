import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `migrate` asks once, and a "no" writes nothing.
 *
 * It used to plan, ask and write file by file: restamps and earlier lifts were already on disk
 * (with their `.bak`) when a later "n" printed "cancelled — nothing was written". In-process, because
 * the prompt needs a terminal a spawned child does not have.
 */
const originalHome = process.env.HHOSTED_HOME
const originalTty = process.stdin.isTTY
const dirs: string[] = []

afterEach(() => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  process.stdin.isTTY = originalTty
  vi.doUnmock('#src/cli/io')
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function homeWithTwoLifts(): { home: string, files: Record<string, string> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-consent-'))
  dirs.push(home)
  const hh = path.join(home, '.hh')
  const stamp = { writtenBy: '0.7.21', schema: 1 }
  const files: Record<string, string> = {}
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    files[file] = `${JSON.stringify(value, null, 2)}\n`
    fs.writeFileSync(file, files[file]!)
  }
  write(path.join(hh, 'workspaces.json'), { workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }] })
  // A restamp, planned first …
  write(path.join(hh, 'settings.json'), { meta: stamp, control: { port: 4100 } })
  for (const id of ['default', 'staging']) {
    // … then two files with a schema step each.
    write(path.join(hh, id, 'settings.json'), { meta: stamp, notifications: { telegram: { enabled: false, chatId: '' } } })
    write(path.join(hh, id, 'servers.config.json'), { meta: stamp, servers: [] })
  }
  return { home, files }
}

describe('migrate consent', () => {
  it('asks once for every schema step, and a "no" leaves every file as it was', async () => {
    const { home, files } = homeWithTwoLifts()
    process.env.HHOSTED_HOME = home
    process.stdin.isTTY = true
    vi.resetModules()
    const questions: string[] = []
    vi.doMock('#src/cli/io', async importOriginal => ({
      ...await importOriginal<typeof import('#src/cli/io')>(),
      prompt: async (question: string) => {
        questions.push(question)
        return 'n'
      },
    }))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { runMigrate } = await import('#src/cli/migrate')

    await runMigrate(false, false)

    expect(questions).toEqual(['Apply 2 migration(s) to 2 file(s)? [y/N] '])
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('cancelled — nothing was written')
    for (const [file, text] of Object.entries(files)) {
      expect(fs.readFileSync(file, 'utf8'), file).toBe(text)
      expect(fs.existsSync(`${file}.bak`), `${file}.bak`).toBe(false)
    }
  })

  /**
   * A home whose **only** pending work is a `kind: "job"` entry must not be told its job moved.
   *
   * The write sat in a block gated on `consented` alone, while the question was gated on
   * `lifts.length > 0`. With no schema steps there was nothing to ask, so `applyJobMove` never ran —
   * and the summary still counted the move from the *plan*, printing "1 job(s) moved" over a file it
   * never wrote. A re-run then said "nothing to migrate", so the job was gone and the command would
   * not offer again. Measured against a built CLI: `servers.config.json` emptied, no `jobs.config.json`
   * created, exit 0.
   *
   * A session that cannot be asked must **refuse**, naming the flag, rather than succeed at nothing.
   */
  it('refuses, rather than claiming a job moved, when it cannot ask', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-jobs-consent-'))
    dirs.push(home)
    const hh = path.join(home, '.hh')
    const servers = path.join(hh, 'default', 'servers.config.json')
    const jobs = path.join(hh, 'default', 'jobs.config.json')
    fs.mkdirSync(path.dirname(servers), { recursive: true })
    fs.writeFileSync(path.join(hh, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`)
    const original = `${JSON.stringify({ meta: { writtenBy: '0.13.0', schema: 2 }, servers: [{ id: 'nightly', command: 'node', args: ['x.js'], kind: 'job', schedule: '0 3 * * *' }] }, null, 2)}\n`
    fs.writeFileSync(servers, original)

    process.env.HHOSTED_HOME = home
    process.stdin.isTTY = false
    delete process.env.HHOSTED_MIGRATE
    vi.resetModules()
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // `fail()` exits the process; the message is the assertion.
    vi.doMock('#src/cli/io', async importOriginal => ({
      ...await importOriginal<typeof import('#src/cli/io')>(),
      fail: (message: string): never => { throw new Error(message) },
    }))
    const { runMigrate } = await import('#src/cli/migrate')

    await expect(runMigrate(false, false)).rejects.toThrow(/--yes|HHOSTED_MIGRATE/)

    // Nothing was written: the servers file still declares the job, and no jobs file appeared.
    expect(fs.readFileSync(servers, 'utf8'), 'the servers file must be untouched').toBe(original)
    expect(fs.existsSync(jobs), 'a move that did not happen must not leave a jobs file').toBe(false)
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).not.toContain('job(s) moved')
  })
})
