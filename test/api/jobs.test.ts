import fs from 'node:fs'
import path from 'node:path'
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
    const body = await ran.json() as Record<string, unknown>
    expect(body).toMatchObject({ ok: false, exitCode: 3 })
    // The response is `jobRunResultSchema`, which requires `signal` beside `exitCode`: a run can end
    // by a signal with no exit code at all, and a client reading only `exitCode` would call that
    // "unknown". The route omitted it, so the documented shape and the answer disagreed.
    expect(body).toHaveProperty('signal')
    expect(body.signal).toBeNull()
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

  /**
   * A job's `secretEnv` reaches the process it spawns.
   *
   * The names were declarable, storable and listed, and `JobsService.resolve()` built the environment
   * from `job.env` alone — so a job that declared `BACKUP_TOKEN` ran without it and nothing said so.
   * A server's spawn has always resolved them; this is the job half.
   */
  it('injects a declared secret into the run, and only a declared one', async () => {
    const created = await makeFixture()
    // The child writes what it actually saw, so the assertion is about the spawned environment
    // rather than about the config that asked for it.
    const out = path.join(created.dir, '.hh', created.defaultId, 'seen.txt')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, [process.env.BACKUP_TOKEN, process.env.UNDECLARED].map(v => String(v)).join('|'))`
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'secretive', command: process.execPath, args: ['-e', script], secretEnv: ['BACKUP_TOKEN'], schedule: '0 3 * * *' }),
    })

    // A value for the declared name, and one for a name the job never declared.
    created.secrets.setServerEnv('secretive', { BACKUP_TOKEN: 'tok-123', UNDECLARED: 'should-not-travel' })

    // The view reports which names have a value, and never the value itself.
    const listed = await (await created.app.request('/api/jobs')).json() as { jobs: Array<Record<string, unknown>> }
    expect(listed.jobs[0]).toMatchObject({ secretEnv: ['BACKUP_TOKEN'], secretEnvSet: ['BACKUP_TOKEN'] })
    expect(JSON.stringify(listed)).not.toContain('tok-123')

    const ran = await created.app.request('/api/jobs/secretive/run', { method: 'POST' })
    expect(ran.status).toBe(200)
    expect(await ran.json()).toMatchObject({ ok: true, exitCode: 0 })

    // The declared name arrived; the undeclared one did not, which is the consent rule.
    expect(fs.readFileSync(out, 'utf8')).toBe('tok-123|undefined')
    await created.cleanup()
  })

  it('runs a job with no secret once it has been cleared', async () => {
    const created = await makeFixture()
    const out = path.join(created.dir, '.hh', created.defaultId, 'after-clear.txt')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, String(process.env.GONE))`
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'clearable', command: process.execPath, args: ['-e', script], secretEnv: ['GONE'], schedule: '0 3 * * *' }),
    })
    created.secrets.setServerEnv('clearable', { GONE: 'bye' })

    const cleared = await created.app.request('/api/jobs/clearable/secrets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unset: ['GONE'] }),
    })
    expect(cleared.status).toBe(200)

    await created.app.request('/api/jobs/clearable/run', { method: 'POST' })
    expect(fs.readFileSync(out, 'utf8')).toBe('undefined')
    await created.cleanup()
  })

  it('refuses a value for a name the job does not declare, and names the fix', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'plain', command: process.execPath, args: ['-e', ''], schedule: '0 3 * * *' }),
    })

    const refused = await created.app.request('/api/jobs/plain/secrets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ set: { NOT_DECLARED: 'x' } }),
    })
    expect(refused.status).toBe(400)
    const body = await refused.json() as { message: string }
    expect(body.message).toContain('NOT_DECLARED')
    expect(body.message).toContain('secretEnv')
    await created.cleanup()
  })

  it('404s a job\'s secrets for a job that does not exist', async () => {
    const created = await makeFixture()
    const response = await created.app.request('/api/jobs/nope/secrets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ set: { A: 'b' } }),
    })
    expect(response.status).toBe(404)
    await created.cleanup()
  })

  /**
   * A run's own output, readable afterwards.
   *
   * It went to the panel log at DEBUG — a level nobody runs a home panel at — so a failed backup's own
   * output, the one thing needed to debug it, was readable nowhere. The view advertised a `logPath`
   * that no route served, which is worse than advertising nothing: it says the panel keeps the output
   * and will not show it.
   */
  it('serves a run\'s own output under the job id', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'noisy',
        command: process.execPath,
        args: ['-e', 'console.log("backup starting"); console.error("disk full")'],
        schedule: '0 3 * * *',
      }),
    })

    const ran = await created.app.request('/api/jobs/noisy/run', { method: 'POST' })
    expect(ran.status).toBe(200)

    const log = await created.app.request('/api/jobs/noisy/log')
    expect(log.status).toBe(200)
    const body = await log.json() as { jobId: string, enabled: boolean, lines: Array<{ stream: string, text: string }> }
    expect(body.jobId).toBe('noisy')
    expect(body.enabled).toBe(true)
    const texts = body.lines.map(line => line.text)
    expect(texts).toContain('backup starting')
    expect(texts).toContain('disk full')
    // The two streams are kept apart, so "the last stderr lines" is a question a page can ask.
    expect(body.lines.find(line => line.text === 'disk full')?.stream).toBe('stderr')
    // And the summary line says how the run ended, so a log read on its own is not ambiguous.
    expect(texts.some(text => /finished in \d+s/.test(text))).toBe(true)
    await created.cleanup()
  })

  it('filters a job log by stream and by search, and 404s an unknown job', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'mixed',
        command: process.execPath,
        args: ['-e', 'console.log("all good"); console.error("it broke")'],
        schedule: '0 3 * * *',
      }),
    })
    await created.app.request('/api/jobs/mixed/run', { method: 'POST' })

    const stderrOnly = await (await created.app.request('/api/jobs/mixed/log?stream=stderr')).json() as { lines: Array<{ text: string }> }
    expect(stderrOnly.lines.map(line => line.text)).toContain('it broke')
    expect(stderrOnly.lines.map(line => line.text)).not.toContain('all good')

    const searched = await (await created.app.request('/api/jobs/mixed/log?search=BROKE')).json() as { lines: Array<{ text: string }> }
    expect(searched.lines.map(line => line.text)).toEqual(['it broke'])

    // A `tail` below the floor is a 400 naming the parameter, never a silent clamp — the same rule a
    // server's log route keeps, because it is the same query schema.
    const refused = await created.app.request('/api/jobs/mixed/log?tail=3')
    expect(refused.status).toBe(400)

    const missing = await created.app.request('/api/jobs/nope/log')
    expect(missing.status).toBe(404)
    await created.cleanup()
  })

  it('answers a job that never ran with an empty log, not a 404', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'idle', command: process.execPath, args: ['-e', ''], schedule: '0 3 * * *' }),
    })

    const log = await created.app.request('/api/jobs/idle/log')
    expect(log.status).toBe(200)
    const body = await log.json() as { lines: unknown[] }
    expect(body.lines).toEqual([])
    await created.cleanup()
  })

  it('drops the log when the job is removed, so a re-declared id starts clean', async () => {
    const created = await makeFixture()
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gone', command: process.execPath, args: ['-e', 'console.log("old run")'], schedule: '0 3 * * *' }),
    })
    await created.app.request('/api/jobs/gone/run', { method: 'POST' })
    await created.app.request('/api/jobs/gone', { method: 'DELETE' })

    // Declared again with the same id: the old run's bytes must not be this job's log.
    await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gone', command: process.execPath, args: ['-e', ''], schedule: '0 3 * * *' }),
    })
    const log = await (await created.app.request('/api/jobs/gone/log')).json() as { lines: Array<{ text: string }> }
    expect(log.lines.map(line => line.text)).not.toContain('old run')
    await created.cleanup()
  })
})
