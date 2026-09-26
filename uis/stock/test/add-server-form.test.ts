import { defaultsSchema, serverCreateSchema } from '@shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import {
  addServerPayload,
  addServerPortError,
  addServerProblem,
  blankAddServerForm,
} from '../src/components/server/addServerForm'

/**
 * Everything the add dialog offers has to reach `servers.config.json`. The
 * advanced options are easy to render and forget to send, and that failure is
 * silent — the entry is created without the option the person just set.
 */
/** The effective `Settings → Server defaults` the dialog seeds itself from. */
function panelDefaults(overrides: Record<string, unknown> = {}) {
  const parsed = defaultsSchema(overrides)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}

describe('add-server payload', () => {
  it('sends the basics, and only the fields that were filled in', () => {
    const payload = addServerPayload(
      { ...blankAddServerForm(), id: 'web', command: 'node', args: '-p\n{port}' },
      panelDefaults(),
    )

    expect(payload).toEqual({ id: 'web', command: 'node', args: ['-p', '{port}'] })
  })

  /**
   * The reported preference: an entry that leaves a field alone must keep
   * inheriting it, so a later `Settings → Server defaults` change still reaches
   * it. Writing the default in would freeze today's value instead.
   */
  it('leaves out every value that only repeats what the entry would inherit', () => {
    const payload = addServerPayload({
      ...blankAddServerForm(),
      id: 'web',
      command: 'node',
      cwd: '.',
      bind: 'local',
      enabled: true,
      autostart: false,
      persistent: false,
      onPortConflict: 'block',
      logBufferLines: 500,
      backupIgnoreGenerated: true,
    }, panelDefaults())

    expect(payload).toEqual({ id: 'web', command: 'node' })
    expect(serverCreateSchema(payload) instanceof type.errors).toBe(false)
  })

  it('carries every advanced option', () => {
    const payload = addServerPayload({
      ...blankAddServerForm(),
      id: 'web',
      label: ' Web ',
      command: 'node',
      cwd: '/srv/web',
      port: 4100,
      bind: 'lan',
      autostart: true,
      persistent: true,
      enabled: false,
      onPortConflict: 'follow',
      logBufferLines: 900,
      dependsOn: 'db, cache',
      envFile: '.env.local',
      env: 'NODE_ENV=production\nPORT=4100',
      dataEnvs: 'DATA_DIR={home}/.web',
      backupPaths: '{home}/.web/uploads',
      backupIgnoreGenerated: false,
      maxRssMb: 512,
    })

    expect(payload).toMatchObject({
      label: 'Web',
      cwd: '/srv/web',
      port: 4100,
      bind: 'lan',
      autostart: true,
      persistent: true,
      enabled: false,
      onPortConflict: 'follow',
      logBufferLines: 900,
      dependsOn: ['db', 'cache'],
      envFile: '.env.local',
      env: { NODE_ENV: 'production', PORT: '4100' },
      dataEnvs: { DATA_DIR: '{home}/.web' },
      backupPaths: ['{home}/.web/uploads'],
      backupIgnoreGenerated: false,
      resources: { maxRssBytes: 512 * 1024 * 1024 },
    })
  })

  it('keeps the generated-file skip on by default, and off as a decision', () => {
    const base = { ...blankAddServerForm(), id: 'web', command: 'node' }
    // On is the schema default, so saying nothing says it; off is a decision.
    expect('backupIgnoreGenerated' in addServerPayload(base)).toBe(false)
    expect(addServerPayload({ ...base, backupIgnoreGenerated: false }).backupIgnoreGenerated).toBe(false)
  })

  it('is a valid create request for the route that receives it', () => {
    const payload = addServerPayload({ ...blankAddServerForm(), id: 'web', command: 'node', port: 4100 })
    expect(serverCreateSchema(payload) instanceof type.errors).toBe(false)
  })

  it('treats a cleared numeric field as "not set" rather than as 0', () => {
    const payload = addServerPayload({
      ...blankAddServerForm(),
      id: 'web',
      command: 'node',
      logBufferLines: Number.NaN,
      maxRssMb: Number.NaN,
    })

    expect('logBufferLines' in payload).toBe(false)
    expect('resources' in payload).toBe(false)
  })
})

describe('add-server validation', () => {
  it('requires an id the supervisor can key an entry by', () => {
    expect(addServerProblem(blankAddServerForm())).toContain('id is required')
    expect(addServerProblem({ ...blankAddServerForm(), id: 'Bad Id', command: 'node' })).toContain('lowercase')
  })

  it('requires a command', () => {
    expect(addServerProblem({ ...blankAddServerForm(), id: 'web' })).toContain('command is required')
  })

  it('bounds the port, but allows none at all', () => {
    const base = { ...blankAddServerForm(), id: 'web', command: 'node' }
    expect(addServerProblem(base)).toBeNull()
    expect(addServerProblem({ ...base, port: 4100 })).toBeNull()
    expect(addServerProblem({ ...base, port: 0 })).toContain('between 1 and 65535')
    expect(addServerProblem({ ...base, port: 70000 })).toContain('between 1 and 65535')
    expect(addServerPortError(4100)).toBeNull()
  })
})

/**
 * A policy group is the one place an entry can stay silent: sending it freezes
 * today's values, so an untouched group must not travel and an entry must keep
 * inheriting whatever the panel defaults become later.
 */
describe('add-server policy groups', () => {
  it('sends nothing that only repeats a panel default it was seeded from', () => {
    const defaults = panelDefaults({ bind: 'lan', autostart: true, onPortConflict: 'warn', logBufferLines: 900 })
    const payload = addServerPayload({ ...blankAddServerForm(defaults), id: 'web', command: 'node' }, defaults)

    expect(payload).toEqual({ id: 'web', command: 'node' })
  })

  it('seeds the entry from the panel defaults, and sends nothing it did not change', () => {
    const defaults = panelDefaults({ autostart: true, bind: 'lan', logBufferLines: 900 })
    const form = { ...blankAddServerForm(defaults), id: 'web', command: 'node' }

    expect(form).toMatchObject({ autostart: true, bind: 'lan' })

    const payload = addServerPayload(form, defaults)
    expect('restart' in payload).toBe(false)
    expect('health' in payload).toBe(false)
    expect('stop' in payload).toBe(false)
    expect('bootstrap' in payload).toBe(false)
    expect(serverCreateSchema(payload) instanceof type.errors).toBe(false)
  })

  it('sends only the group that was changed', () => {
    const defaults = panelDefaults()
    const form = {
      ...blankAddServerForm(defaults),
      id: 'web',
      command: 'node',
      restart: { ...defaults.restart, maxRetries: 9 },
    }

    const payload = addServerPayload(form, defaults)
    expect(payload.restart).toEqual({ ...defaults.restart, maxRetries: 9 })
    expect('health' in payload).toBe(false)
    expect('stop' in payload).toBe(false)
  })

  it('falls back to the schema\'s own defaults when no panel defaults were loaded', () => {
    const form = { ...blankAddServerForm(), id: 'web', command: 'node' }
    const payload = addServerPayload(form)

    // Nothing is written that the entry would inherit anyway — including the
    // groups, which are seeded to the same schema defaults the form shows.
    expect(payload).toEqual({ id: 'web', command: 'node' })
    expect(serverCreateSchema(payload) instanceof type.errors).toBe(false)
  })

  it('sends a bootstrap only when it is on, with a sane timeout', () => {
    const base = { ...blankAddServerForm(), id: 'web', command: 'node' }
    expect('bootstrap' in addServerPayload({ ...base, bootstrapEnabled: false, bootstrapCommand: './install.sh' })).toBe(false)

    const payload = addServerPayload({
      ...base,
      bootstrapEnabled: true,
      bootstrapCommand: './install.sh',
      bootstrapArgs: '--verbose',
      bootstrapEnv: 'CI=1',
      bootstrapTimeoutMs: 5,
    })

    expect(payload.bootstrap).toEqual({
      command: './install.sh',
      args: ['--verbose'],
      env: { CI: '1' },
      timeoutMs: 120000,
      runOnce: true,
    })
    expect(addServerProblem({ ...base, bootstrapEnabled: true })).toContain('bootstrap needs a command')
  })
})
