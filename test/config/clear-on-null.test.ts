import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { applyPatch, mergeGroup } from '#src/config/patch'
import { WorkspaceStore } from '#src/config/store'
import { serverPatchSchema } from '#src/shared/contracts'

/**
 * An explicit `null` **removes** a key, at the top level as well as inside a group.
 *
 * The repo rule is stated that way, and `mergeGroup` always did it — but `applyPatch` *set* `null` for a
 * top-level key, so the two paths disagreed. It was reachable all along: `label` is not in
 * `SERVER_MERGE_KEYS`, so `updateServer(id, { label: null })` took the plain-set branch, stored `null`, and
 * the schema that reads the file then refused the whole config:
 * `servers[0]: label must be a string (was null)`.
 *
 * Clearing a label is what makes this matter: every display falls back with `label ?? id`, which fires on
 * `null`/`undefined` and not on `''`, so an absent key is the only spelling that shows the id again.
 */
describe('clearing a key with null', () => {
  it('removes it at the top level, as it already did inside a group', () => {
    const target: Record<string, unknown> = { label: 'Demo', command: 'node', health: { enabled: true, intervalMs: 5000 } }

    applyPatch(target, { label: null }, new Set(['health']))
    expect('label' in target, 'a cleared top-level key must be gone, not null').toBe(false)
    // The value a display would show, which is the point of removing rather than blanking.
    expect(target.label ?? 'web').toBe('web')

    // The group path already behaved this way, and still does.
    applyPatch(target, { health: { intervalMs: null } }, new Set(['health']))
    expect(target.health).toEqual({ enabled: true })
    expect(mergeGroup({ a: 1 }, { a: null })).toEqual({})
  })

  it('still ignores an undefined value, and still sets a real one', () => {
    const target: Record<string, unknown> = { label: 'Demo' }
    applyPatch(target, { label: undefined }, new Set())
    expect(target.label).toBe('Demo')
    applyPatch(target, { label: 'Renamed' }, new Set())
    expect(target.label).toBe('Renamed')
  })
})

/**
 * A field whose `null` is a *value* must survive the change too.
 *
 * `serverSchema.port` is `number | null`, where `null` means "no port" rather than "unset" — so removing
 * the key looks like it could change the meaning. It does not: `parse.ts` normalises `server.port ?? null`
 * and `store.ts` does the same, so an absent key and an explicit `null` read identically. The file simply
 * keeps the canonical spelling instead of a key whose only meaning is "no port".
 */
describe('a field where null is a value', () => {
  it('reads the same whether the key is absent or explicitly null', () => {
    for (const entry of [{ id: 'web', command: 'node', port: null }, { id: 'web', command: 'node' }]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-nullvalue-'))
      try {
        const file = path.join(dir, 'servers.config.json')
        fs.writeFileSync(file, JSON.stringify({ servers: [entry] }))
        const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), file)
        store.load()
        expect(store.getServer('web')?.port, JSON.stringify(entry)).toBeNull()
      }
      finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('and clearing it through the store removes the key, still reading as null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-nullclear-'))
    try {
      const file = path.join(dir, 'servers.config.json')
      fs.writeFileSync(file, JSON.stringify({ servers: [{ id: 'web', command: 'node', port: 4000 }] }))
      const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), file)
      store.load()

      store.updateServer('web', { port: null } as never)
      expect(store.getServer('web')?.port).toBeNull()
      // The canonical spelling: no key at all, which `parse` normalises back to null.
      expect(fs.readFileSync(file, 'utf8')).not.toContain('"port"')
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A hand-edited `null` must not refuse the whole config.
 *
 * The file format already spells "unset" as `null` for `port` and `bootstrap`, so `label` refusing it was
 * an inconsistency — and an expensive one: `"label": null` made the panel reject the **entire** servers
 * file with `servers[0] ("web"): label must be a string (was null)`, losing every entry over one field.
 * It is now accepted and normalised to absent, the same treatment `port` gets.
 */
describe('a null written by hand', () => {
  it('loads, and reads as no label', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-hand-null-'))
    try {
      const file = path.join(dir, 'servers.config.json')
      fs.writeFileSync(file, JSON.stringify({
        servers: [
          { id: 'web', command: 'node', label: null, port: null, bootstrap: null },
          { id: 'api', command: 'node', label: 'API' },
        ],
      }))
      const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), file)
      store.load()

      // The whole file loads, not just the entry without the nulls.
      expect(store.configError, 'a null label must not refuse the config').toBeNull()
      expect(store.getServer('api')?.label, 'the other entry survives').toBe('API')

      const web = store.getServer('web')
      expect(web).toBeDefined()
      expect(web?.label).toBeUndefined()
      // What every display shows.
      expect(web?.label ?? web?.id).toBe('web')
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The schemas either side of the write, which the two commits that fixed the *primitive* both missed.
 *
 * `applyPatch` deleting on `null` is only reachable if something can *send* `null`. Both UIs validate
 * their payload with `serverPatchSchema` before saving and PATCH the same shape, so a patch schema that
 * refused `null` made clearing a Label unsaveable — "label must be a string (was null)" — and the UI test
 * added alongside it asserted only that the change was *reviewed*, never that it was accepted.
 */
describe('the patch schema accepts the null the editor sends', () => {
  it('takes null for label, and still refuses anything undeclared', () => {
    expect(serverPatchSchema({ label: null }) instanceof type.errors, 'clearing must be expressible').toBe(false)
    // A real label and the removal spelling both stay valid.
    expect(serverPatchSchema({ label: 'Renamed' }) instanceof type.errors).toBe(false)
    // The strict shape is untouched: an undeclared key is still refused.
    expect(serverPatchSchema({ nope: 1 }) instanceof type.errors).toBe(true)
  })

  it('reaches the store, so the key is removed rather than nulled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-clear-label-'))
    try {
      const file = path.join(dir, 'servers.config.json')
      fs.writeFileSync(file, JSON.stringify({ servers: [{ id: 'web', command: 'node', label: 'Demo' }] }))
      const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), file)
      store.load()

      store.updateServer('web', { label: null })
      expect(store.getServer('web')?.label, 'the display falls back to the id').toBeUndefined()
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).servers[0], 'the key is absent in the file').not.toHaveProperty('label')
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
