import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './fixture'

/**
 * `/api/jobs` end to end: create, list, edit, run, remove.
 *
 * The fixture gives the panel a **real** jobs service — its store is a file in the test's home and a
 * run is a real child process — so these are the routes as a client meets them, not a stub's answer.
 */

describe('the jobs API', () => {
  it('creates a job, lists it, and answers the exit code of a run', async () => {
    const created = await makeFixture()

    const made = await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'hello', command: process.execPath, args: ['-e', 'process.exitCode = 0'], schedule: '0 3 * * *' }),
    })
    expect(made.status).toBe(201)
    const { job } = await made.json() as { job: { id: string, schedule: string, enabled: boolean, nextRunAt: number | null } }
    expect(job.id).toBe('hello')
    expect(job.schedule).toBe('0 3 * * *')
    // Defaults filled by the schema, not by the route.
    expect(job.enabled).toBe(true)
    expect(job.nextRunAt).toBeTypeOf('number')

    const listed = await (await created.app.request('/api/jobs')).json() as { jobs: Array<{ id: string }> }
    expect(listed.jobs.map(entry => entry.id)).toEqual(['hello'])

    const ran = await created.app.request('/api/jobs/hello/run', { method: 'POST' })
    expect(ran.status).toBe(200)
    expect(await ran.json()).toMatchObject({ ok: true, exitCode: 0 })
    await created.cleanup()
  })

  it('answers a failing run as 200 with the exit code, because the code is the outcome', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bad', command: process.execPath, args: ['-e', 'process.exitCode = 3'], schedule: '0 3 * * *' }),
    })

    const ran = await created.app.request('/api/jobs/bad/run', { method: 'POST' })
    // 200, not 409: the run happened. Its exit code is the answer, and a script branches on that.
    expect(ran.status).toBe(200)
    expect(await ran.json()).toMatchObject({ ok: false, exitCode: 3 })
    await created.cleanup()
  })

  it('edits one, and clears a label with null', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'job', command: 'true', schedule: '0 3 * * *', label: 'Nightly' }),
    })

    const patched = await created.app.request('/api/jobs/job', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: null, schedule: '30 4 * * *' }),
    })
    expect(patched.status).toBe(200)
    const { job } = await patched.json() as { job: { label?: string, schedule: string } }
    expect(job.schedule).toBe('30 4 * * *')
    expect(job).not.toHaveProperty('label')
    await created.cleanup()
  })

  it('removes one, and answers 404 afterwards', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gone', command: 'true', schedule: '0 3 * * *' }),
    })

    expect((await created.app.request('/api/jobs/gone', { method: 'DELETE' })).status).toBe(200)
    expect((await created.app.request('/api/jobs/gone/run', { method: 'POST' })).status).toBe(404)
    expect((await created.app.request('/api/jobs/gone', { method: 'DELETE' })).status).toBe(404)
    await created.cleanup()
  })

  it('refuses a duplicate id with 409, naming why', async () => {
    const created = await makeFixture()
    const body = JSON.stringify({ id: 'twice', command: 'true', schedule: '0 3 * * *' })
    expect((await created.app.request('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(201)

    const second = await created.app.request('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'JOB_EXISTS' })
    await created.cleanup()
  })

  it('refuses a schedule that does not parse, and stores nothing', async () => {
    const created = await makeFixture()
    const response = await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'broken', command: 'true', schedule: '0 99 * * *' }),
    })
    expect([400, 409]).toContain(response.status)
    const listed = await (await created.app.request('/api/jobs')).json() as { jobs: unknown[] }
    expect(listed.jobs).toEqual([])
    await created.cleanup()
  })

  /**
   * A job is not a server: the shape that used to mean "this entry is a job" is refused now, because
   * `kind` is gone and `schedule` belongs on a job.
   */
  it('refuses job fields on a server entry', async () => {
    const created = await makeFixture()
    const response = await created.app.request('/api/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-job', command: 'true', kind: 'job', schedule: '0 3 * * *' }),
    })
    expect(response.status).toBe(400)
    await created.cleanup()
  })
})
