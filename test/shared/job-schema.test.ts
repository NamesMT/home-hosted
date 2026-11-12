import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { cronExpressionSchema, serverCreateSchema, serverKindProblems, serverPatchSchema, serverSchema, serverViewSchema } from '#src/shared/contracts'

/**
 * The `kind`/`schedule` pair.
 *
 * Two layers are tested apart, because they fail differently: the schema proves the **shape**
 * (`schedule` is five fields; `kind` is one of two words), and `serverKindProblems` proves the
 * **relationship** (a job has no port, a service has no schedule, the expression parses). A schema
 * `narrow` could have expressed the second, but `toJsonSchema()` cannot render a predicate and every
 * route's OpenAPI document calls it.
 */

function unwrap<T>(value: T | type.errors): T {
  if (value instanceof type.errors)
    throw new Error(value.summary)
  return value
}

describe('kind and schedule in the schema', () => {
  it('defaults an entry to a service, so an old config keeps its meaning', () => {
    const parsed = unwrap(serverSchema({ id: 'web', command: 'node' }))
    expect(parsed.kind).toBe('service')
    expect('schedule' in parsed).toBe(false)
  })

  it('accepts a job with a schedule', () => {
    const parsed = unwrap(serverSchema({ id: 'backup', command: 'node', kind: 'job', schedule: '0 3 * * *' }))
    expect(parsed.kind).toBe('job')
    expect(parsed.schedule).toBe('0 3 * * *')
  })

  it('refuses a kind that is neither word', () => {
    expect(serverSchema({ id: 'a', command: 'node', kind: 'daemon' } as never) instanceof type.errors).toBe(true)
  })

  it('refuses a 6-field expression and a macro at the schema, on the field shape alone', () => {
    const six = serverSchema({ id: 'a', command: 'node', kind: 'job', schedule: '0 0 3 * * *' })
    expect(six instanceof type.errors).toBe(true)
    expect(six instanceof type.errors ? six.summary : '').toMatch(/5-field cron expression/)

    const macro = serverSchema({ id: 'a', command: 'node', kind: 'job', schedule: '@daily' })
    expect(macro instanceof type.errors).toBe(true)

    // Four fields is the other half of the same mistake.
    expect(cronExpressionSchema('0 3 * *') instanceof type.errors).toBe(true)
    expect(cronExpressionSchema('0 3 * * *') instanceof type.errors).toBe(false)
  })

  it('carries both through the patch and the create schemas', () => {
    expect(unwrap(serverPatchSchema({ kind: 'job' }))).toEqual({ kind: 'job' })
    expect(unwrap(serverPatchSchema({ schedule: '*/5 * * * *' }))).toEqual({ schedule: '*/5 * * * *' })
    // `null` clears it, the spelling every optional scalar uses in a patch.
    expect(unwrap(serverPatchSchema({ schedule: null } as never))).toEqual({ schedule: null })
    expect(serverPatchSchema({ schedule: '@daily' }) instanceof type.errors).toBe(true)
    expect(unwrap(serverCreateSchema({ id: 'a', command: 'node', kind: 'job', schedule: '0 3 * * *' })).kind).toBe('job')
  })

  it('mirrors the base schema field for field, so the patch can send both', () => {
    const base = Object.keys((serverSchema.toJsonSchema() as { properties: Record<string, unknown> }).properties)
    const patch = Object.keys((serverPatchSchema.toJsonSchema() as { properties: Record<string, unknown> }).properties)
    expect(base).toContain('kind')
    expect(base).toContain('schedule')
    expect([...patch, 'id'].sort()).toEqual([...base].sort())
  })

  it('lets a view carry the job block, and parses one without it', () => {
    const view = {
      id: 'a',
      config: { id: 'a', command: 'node', kind: 'job', schedule: '0 3 * * *' },
      bindHost: '127.0.0.1',
      url: null,
      status: 'stopped',
      health: 'disabled',
      portState: 'unknown',
      pid: null,
      startedAt: null,
      exitCode: 0,
      exitSignal: null,
      restarts: 0,
      maxRetries: 0,
      lastError: null,
      nextRetryAt: null,
      unhealthySince: null,
      bufferedLines: 0,
      history: { windowMs: 1, uptimeRatio: null, restarts: 0, crashes: 0, forcedRestarts: 0, lastCrashAt: null, lastExitAt: null, lastRuntimeMs: null, events: [] },
      responseMs: null,
      resources: null,
    }
    // Absent is fine: an older panel sends no `job`, and this schema must not reject the frame.
    expect(serverViewSchema(view) instanceof type.errors).toBe(false)
    const withJob = { ...view, job: { running: false, nextRunAt: 1_700_000_000_000, lastRunAt: null, lastExitCode: 0 } }
    expect(serverViewSchema(withJob) instanceof type.errors).toBe(false)
  })
})

describe('serverKindProblems', () => {
  it('accepts the two ordinary shapes', () => {
    expect(serverKindProblems({ kind: 'service' })).toEqual([])
    expect(serverKindProblems({ kind: 'job', schedule: '0 3 * * *' })).toEqual([])
  })

  it('refuses a job with a port, a health check, a restart policy or persistence', () => {
    expect(serverKindProblems({ kind: 'job', schedule: '0 3 * * *', port: 4000 }).join()).toMatch(/no port/)
    expect(serverKindProblems({ kind: 'job', schedule: '0 3 * * *', declaredKeys: ['health'] }).join()).toMatch(/no health check/)
    expect(serverKindProblems({ kind: 'job', schedule: '0 3 * * *', declaredKeys: ['restart'] }).join()).toMatch(/no restart policy/)
    expect(serverKindProblems({ kind: 'job', schedule: '0 3 * * *', declaredKeys: ['persistent'] }).join()).toMatch(/persistent/)
  })

  it('judges only a group the file declares, never the resolved default', () => {
    // Every stored entry resolves `health`/`restart` from the workspace defaults; refusing those
    // would refuse every job ever created.
    const resolvedJob = { kind: 'job' as const, schedule: '0 3 * * *', declaredKeys: ['command', 'kind', 'schedule'] }
    expect(serverKindProblems(resolvedJob)).toEqual([])
  })

  it('refuses a job with no schedule, because it would never run', () => {
    expect(serverKindProblems({ kind: 'job' }).join()).toMatch(/needs a `schedule`/)
  })

  it('refuses a schedule on a service, which has its own lifecycle', () => {
    expect(serverKindProblems({ kind: 'service', schedule: '0 3 * * *' }).join()).toMatch(/only for a job/)
  })

  it('refuses a schedule whose contents do not parse, in the terms the person typed', () => {
    const problem = serverKindProblems({ kind: 'job', schedule: '0 3 * * nope' }).join()
    expect(problem).toMatch(/schedule:/)
    expect(problem).toMatch(/nope/)
    // A shape-valid expression with an out-of-range field is this layer's job, not the schema's.
    expect(serverKindProblems({ kind: 'job', schedule: '99 3 * * *' }).join()).toMatch(/between 0 and 59/)
  })

  it('reports every problem at once, so one save does not reveal them one by one', () => {
    const problems = serverKindProblems({ kind: 'job', port: 4000, declaredKeys: ['health', 'restart', 'persistent'] })
    expect(problems.length).toBe(5)
  })
})
