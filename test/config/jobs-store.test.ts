import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { jobProblems, JobStore } from '#src/config/jobs'

/**
 * A workspace's jobs live in their own file, and a bad one is refused where it lands.
 *
 * This is the domain that came out of `kind: "job"` on a server entry. What matters is that the file
 * has one shape, that a job which cannot run never reaches disk, and that a hand-edit in progress is
 * never overwritten by the panel.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function store(): JobStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-jobs-'))
  dirs.push(dir)
  return new JobStore(path.join(dir, 'jobs.config.json'))
}

function job(overrides: Record<string, unknown> = {}) {
  return { id: 'backup', command: 'node', args: ['backup.js'], schedule: '0 3 * * *', ...overrides } as never
}

describe('the jobs store', () => {
  it('starts empty, and writes the file with its meta stamp', () => {
    const jobs = store()
    expect(jobs.listOrEmpty()).toEqual([])

    jobs.add(job())
    expect(jobs.list()).toHaveLength(1)

    const raw = JSON.parse(fs.readFileSync(jobsFile(jobs), 'utf8')) as { meta: { writtenBy: string, schema: number } }
    expect(raw.meta.writtenBy).toBe('home-hosted')
    expect(typeof raw.meta.schema).toBe('number')
  })

  it('refuses a duplicate id, because an id names a log file and history events', () => {
    const jobs = store()
    jobs.add(job())
    expect(() => jobs.add(job())).toThrow(/already exists/)
  })

  it('refuses a schedule that does not parse, and keeps the file as it was', () => {
    const jobs = store()
    jobs.add(job())

    expect(() => jobs.add(job({ id: 'broken', schedule: '0 99 * * *' }))).toThrow(/schedule/)
    expect(jobs.list().map(entry => entry.id), 'the good job is untouched').toEqual(['backup'])
  })

  it('refuses a name declared twice in secretEnv', () => {
    const jobs = store()
    expect(() => jobs.add(job({ secretEnv: ['A', 'A'] }))).toThrow(/twice/)
  })

  it('updates one in place, and clears a label with null', () => {
    const jobs = store()
    jobs.add(job({ label: 'Nightly' }))
    const updated = jobs.update('backup', { label: null, schedule: '30 4 * * *' })
    expect(updated?.schedule).toBe('30 4 * * *')
    expect(updated).not.toHaveProperty('label')
    expect(jobs.update('ghost', { schedule: '0 1 * * *' })).toBeNull()
  })

  it('removes one, and reports whether it was there', () => {
    const jobs = store()
    jobs.add(job())
    expect(jobs.remove('backup')).toBe(true)
    expect(jobs.remove('backup')).toBe(false)
    expect(jobs.listOrEmpty()).toEqual([])
  })

  /**
   * A hand-edit mid-typing is somebody's work, so a write refuses rather than replacing it. The same
   * rule `SecretsStore.save` and `WorkspaceStore` follow: an unparseable file is not ours to overwrite.
   */
  it('refuses to write over a file it cannot parse', () => {
    const jobs = store()
    jobs.add(job())
    fs.writeFileSync(jobsFile(jobs), '{ "jobs": [ { "id": ')

    expect(() => jobs.add(job({ id: 'another' }))).toThrow(/not readable JSON/)
    expect(fs.readFileSync(jobsFile(jobs), 'utf8'), 'the broken file is left alone').toContain('"id": ')
  })

  it('tells a broken file from an empty one', () => {
    const jobs = store()
    jobs.add(job())
    fs.writeFileSync(jobsFile(jobs), JSON.stringify({ jobs: [{ id: 'x' }] }))
    // `listOrEmpty` is not "swallow errors": a file that exists and is wrong is reported.
    expect(() => jobs.listOrEmpty()).toThrow(/not a jobs file|runnable/)
  })
})

describe('jobProblems', () => {
  it('names the schedule problem in the terms the person typed', () => {
    expect(jobProblems({ schedule: '0 99 * * *' }).join(' ')).toMatch(/hour/)
    expect(jobProblems({ schedule: '0 3 * * *' })).toEqual([])
  })

  it('refuses a 6-field expression, which would run on a schedule nobody typed', () => {
    expect(jobProblems({ schedule: '0 0 3 * * *' }).join(' ')).toMatch(/6/)
  })
})

/** The file this store owns, read off the instance the test holds. */
function jobsFile(jobs: JobStore): string {
  return (jobs as unknown as { file: string }).file
}
