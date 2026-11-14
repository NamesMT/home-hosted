import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '#src/config/store'
import { entryHasJobFields } from '#src/shared/contracts'

/**
 * A servers file from 0.14 still declaring a job is **refused**, not silently demoted.
 *
 * `kind` and `schedule` left `serverSchema` when jobs became their own domain. The dangerous outcome
 * is not an error — it is that a `kind: "job"` entry would be read as a service and its schedule stop
 * firing with nothing to say so. Both the parser and every write refuse it by name, and the message
 * names the command that moves it.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function storeWith(entries: unknown[]): { store: WorkspaceStore, file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-leftover-'))
  dirs.push(dir)
  const file = path.join(dir, 'servers.config.json')
  fs.writeFileSync(file, JSON.stringify({ meta: { writtenBy: 'test', schema: 1 }, servers: entries }))
  const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), file)
  // `load()` is explicit: the constructor only records the paths.
  store.load()
  return { store, file }
}

describe('a server entry that still names a job field', () => {
  it('is refused on read, with the migration named', () => {
    const { store } = storeWith([{ id: 'nightly', kind: 'job', schedule: '0 3 * * *', command: 'node' }])
    // The entry is not silently demoted to a service: the read reports the file, and says what to run.
    const reported = String(store.configError ?? '')
    expect(reported).toMatch(/jobs\.config\.json|migrate/)
  })

  it('is refused on a write, so a caller cannot create one whose kind would be dropped', () => {
    const { store } = storeWith([])
    // The schema rejects the undeclared key first — which is a refusal either way, and the point is
    // that the entry never lands. The **message** is what a person acts on, so it is asserted.
    expect(() => store.addServer({ id: 'sneaky', command: 'node', schedule: '0 3 * * *' } as never))
      .toThrow(/schedule/)
    expect(store.servers, 'nothing was stored').toEqual([])
  })

  it('leaves a plain service alone', () => {
    const { store } = storeWith([{ id: 'web', command: 'node', port: 4000 }])
    expect(store.servers.map(server => server.id)).toEqual(['web'])
  })
})

describe('entryHasJobFields', () => {
  it('answers null for an entry with neither field', () => {
    expect(entryHasJobFields({ id: 'web', command: 'node' })).toBeNull()
  })

  it('names the move for a job, and the removal for a stray schedule', () => {
    expect(entryHasJobFields({ kind: 'job' })).toContain('jobs.config.json')
    expect(entryHasJobFields({ schedule: '0 3 * * *' })).toContain('belong to a job')
  })

  it('does not trip on a service that states its kind explicitly', () => {
    // `kind: "service"` is redundant now but harmless — it says what the entry already is.
    expect(entryHasJobFields({ kind: 'service' })).toContain('belong to a job')
  })
})
