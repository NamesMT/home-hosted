import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { parseServersFile } from '#src/config/parse'
import { ConfigError, WorkspaceStore } from '#src/config/store'

/**
 * `kind`/`schedule` at the two doors a config goes through: a **write** (`addServer`/`updateServer`/
 * `putServer`, which `POST`/`PATCH`/`PUT` and the offline CLI all use) and a **read**
 * (`parseServersFile`, which `up` refuses on).
 *
 * The pair is enforced by `serverKindProblems`, not by the schema, so this is the file that proves
 * the call sites are wired — a pure-function test of the predicate stayed green with both wirings
 * deleted, which is the trap `.agentDocs/GOTCHAS.md` names ("a pure-function test does not pin its
 * call site").
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempStore(servers: Record<string, unknown>[] = []): Promise<{ store: WorkspaceStore, serversFile: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-jobs-'))
  dirs.push(dir)
  const settingsFile = path.join(dir, 'settings.json')
  const serversFile = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(settingsFile, JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }, null, 2))
  await fs.promises.writeFile(serversFile, JSON.stringify({ servers, meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }, null, 2))
  const store = new WorkspaceStore('default', settingsFile, serversFile)
  store.load()
  return { store, serversFile }
}

/** A job entry in the shape a person would write. */
function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'nightly', command: 'node', args: ['-e', ''], kind: 'job', schedule: '0 3 * * *', ...overrides }
}

describe('a write refuses a bad kind/schedule pair', () => {
  it('accepts a job with a schedule and stores both', async () => {
    const { store } = await tempStore()
    const written = store.addServer(job())
    expect(written.kind).toBe('job')
    expect(written.schedule).toBe('0 3 * * *')
    // The stored form resolves the groups a job does not declare, which is why the check reads the
    // declared keys rather than the resolved entry.
    expect(store.getServer('nightly')?.kind).toBe('job')
  })

  it('refuses a job that declares a port, and names the field', async () => {
    const { store } = await tempStore()
    expect(() => store.addServer(job({ port: 4100 }))).toThrow(ConfigError)
    expect(() => store.addServer(job({ port: 4100 }))).toThrow(/has no port/)
    // Nothing was written: a refused add leaves the file alone.
    expect(store.getServer('nightly')).toBeUndefined()
  })

  it('refuses a job that declares a health check, a restart policy or persistence', async () => {
    const { store } = await tempStore()
    expect(() => store.addServer(job({ health: { enabled: true } }))).toThrow(/no health check/)
    expect(() => store.addServer(job({ restart: { enabled: true } }))).toThrow(/no restart policy/)
    expect(() => store.addServer(job({ persistent: true }))).toThrow(/persistent/)
  })

  it('refuses a schedule on a service, and a job with none', async () => {
    const { store } = await tempStore()
    expect(() => store.addServer({ id: 'web', command: 'node', schedule: '0 3 * * *' })).toThrow(/only for a job/)
    expect(() => store.addServer({ id: 'nope', command: 'node', kind: 'job' })).toThrow(/needs a `schedule`/)
  })

  it('refuses a schedule whose contents do not parse, through the patch as well', async () => {
    const { store } = await tempStore([job()])
    expect(() => store.updateServer('nightly', { schedule: '0 3 * * nope' })).toThrow(/schedule:/)
    expect(() => store.updateServer('nightly', { schedule: '99 3 * * *' })).toThrow(/between 0 and 59/)
    // A valid edit lands.
    expect(store.updateServer('nightly', { schedule: '*/15 * * * *' }).schedule).toBe('*/15 * * * *')
  })

  it('refuses turning a service into a job unless the port goes with it', async () => {
    const { store } = await tempStore([{ id: 'web', command: 'node', port: 4100 }])
    // `port` is not in `SERVER_MERGE_KEYS`, so an omitted key keeps the stored one: the pair is what
    // is refused, and the message says which field to drop.
    expect(() => store.updateServer('web', { kind: 'job', schedule: '0 3 * * *' })).toThrow(/has no port/)
    const converted = store.updateServer('web', { kind: 'job', schedule: '0 3 * * *', port: null })
    expect(converted.kind).toBe('job')
    expect(converted.port).toBeNull()
  })
})

describe('a read reports what the write would refuse', () => {
  const parse = (servers: Record<string, unknown>[]) => parseServersFile({ servers, meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }, {})

  it('accepts a job', () => {
    const parsed = parse([job()])
    expect(parsed.errors).toEqual([])
    expect(parsed.servers).toHaveLength(1)
    expect(parsed.servers[0]!.schedule).toBe('0 3 * * *')
  })

  it('refuses a hand-edited job with a port, naming the entry and the field', () => {
    const parsed = parse([job({ port: 4100 })])
    expect(parsed.servers).toHaveLength(0)
    expect(parsed.errors.join()).toMatch(/"nightly"/)
    expect(parsed.errors.join()).toMatch(/has no port/)
  })

  it('refuses a hand-edited expression that does not parse', () => {
    const parsed = parse([job({ schedule: '0 3 * * funday' })])
    expect(parsed.errors.join()).toMatch(/schedule:/)
    expect(parsed.errors.join()).toMatch(/funday/)
  })
})
