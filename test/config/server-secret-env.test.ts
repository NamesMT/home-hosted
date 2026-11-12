import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretsStore } from '#src/config/secrets'
import { duplicateSecretEnvNames, serverPatchSchema, serverSchema } from '#src/shared/contracts'

/**
 * A server's secret environment: **the names** live in the config, the values never do.
 *
 * A homelab service's secrets usually sit in an `envFile` beside its code — which a backup does not
 * include, so a move to a new machine silently loses them, and nothing on the panel says they are
 * missing. `secretEnv` declares the *names* on the entry; the workspace's `.secrets.json` (0600,
 * written atomically) holds the values.
 *
 * Two rules this file pins, and they are the whole security story:
 *  - a name is a valid environment-variable name, unique, and nothing else may appear in the array;
 *  - the value is **never** in the config, so no view, log, history event or error can carry it.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secretenv-'))
  dirs.push(dir)
  return dir
}

describe('secretEnv on the server schema', () => {
  it('accepts environment-variable names', () => {
    const entry = { id: 'web', command: 'node', secretEnv: ['DATABASE_URL', '_PRIVATE', 'A1'] }
    expect(serverSchema(entry) instanceof type.errors, 'valid names are accepted').toBe(false)
  })

  it.each([
    ['a name starting with a digit', ['1BAD']],
    ['a name with a dash', ['MY-VAR']],
    ['a name with a space', ['MY VAR']],
    ['an empty name', ['']],
    ['a name with an equals sign', ['A=B']],
  ])('refuses %s', (_what, names) => {
    expect(serverSchema({ id: 'web', command: 'node', secretEnv: names }) instanceof type.errors).toBe(true)
  })

  it('reports a duplicate name through the predicate, not the schema', () => {
    // A duplicate cannot be a set, and the second value would silently win at spawn. It is a
    // **predicate** rather than a schema `narrow`, because a `narrow` cannot be rendered to JSON
    // Schema and every route's OpenAPI document calls `toJsonSchema()` — the same reason
    // `duplicateWebhookIds` sits beside `notificationsSchema`.
    expect(duplicateSecretEnvNames(['A', 'A', 'B'])).toEqual(['A'])
    expect(duplicateSecretEnvNames(['A', 'B'])).toEqual([])
    // And the schema still renders, which is the point of keeping it out.
    expect(() => serverSchema.toJsonSchema()).not.toThrow()
  })

  it('is optional, and absent by default', () => {
    const parsed = serverSchema({ id: 'web', command: 'node' })
    expect(parsed instanceof type.errors).toBe(false)
    // A default, not `undefined`: every stored entry carries the list, so the spawn code and the
    // editor read one shape. Empty means "no secrets", which is the ordinary case.
    expect((parsed as { secretEnv: string[] }).secretEnv).toEqual([])
  })

  it('is in the patch schema too, so the editor can change it', () => {
    expect(serverPatchSchema({ secretEnv: ['A'] }) instanceof type.errors).toBe(false)
    expect(serverPatchSchema({ secretEnv: ['1BAD'] }) instanceof type.errors).toBe(true)
  })
})

describe('the workspace store keeps the values out of the config', () => {
  it('stores values in the secrets file, keyed by server and name', async () => {
    const dir = await scratch()
    const store = new SecretsStore(path.join(dir, '.secrets.json'), undefined, 'workspace')
    store.setServerEnv('web', { DATABASE_URL: 'postgres://user:pw@db/app' })

    const raw = fs.readFileSync(path.join(dir, '.secrets.json'), 'utf8')
    expect(raw, 'the value is in the secrets file').toContain('postgres://user:pw@db/app')
    // 0600: the same rule every secret file follows.
    expect(fs.statSync(path.join(dir, '.secrets.json')).mode & 0o777).toBe(0o600)
  })

  it('reads them back, and reports which names have a value without the values', async () => {
    const dir = await scratch()
    const store = new SecretsStore(path.join(dir, '.secrets.json'), undefined, 'workspace')
    store.setServerEnv('web', { DATABASE_URL: 'secret-value', API_KEY: 'another' })

    expect(store.serverEnv('web')).toEqual({ DATABASE_URL: 'secret-value', API_KEY: 'another' })
    // What a view may show: the names only.
    expect(store.serverEnvNames('web').sort()).toEqual(['API_KEY', 'DATABASE_URL'])
  })

  it('replaces the set for one server without touching another', async () => {
    const dir = await scratch()
    const store = new SecretsStore(path.join(dir, '.secrets.json'), undefined, 'workspace')
    store.setServerEnv('web', { A: '1' })
    store.setServerEnv('api', { B: '2' })
    store.setServerEnv('web', { C: '3' })

    expect(store.serverEnv('web')).toEqual({ C: '3' })
    expect(store.serverEnv('api'), 'another server keeps its values').toEqual({ B: '2' })
  })

  it('deletes one name, and everything for a removed server', async () => {
    const dir = await scratch()
    const store = new SecretsStore(path.join(dir, '.secrets.json'), undefined, 'workspace')
    store.setServerEnv('web', { A: '1', B: '2' })
    store.unsetServerEnv('web', ['A'])
    expect(store.serverEnv('web')).toEqual({ B: '2' })

    store.forgetServerEnv('web')
    expect(store.serverEnv('web')).toEqual({})
  })

  it('refuses a name that is not an environment-variable name', async () => {
    const dir = await scratch()
    const store = new SecretsStore(path.join(dir, '.secrets.json'), undefined, 'workspace')
    // The store is the last line, not the first: a caller that bypassed the API still cannot put a
    // name into a child's environment that no shell could read.
    expect(() => store.setServerEnv('web', { 'BAD-NAME': 'x' })).toThrow(/environment.variable name/)
  })

  it('keeps values out of a store of the other scope', async () => {
    const dir = await scratch()
    const globalStore = new SecretsStore(path.join(dir, '.control-secrets.json'), undefined, 'global')
    // A global store neither reads nor writes a server's environment — that is the workspace's file.
    // (`all` is the pre-workspace shape a backup archive carries, and it owns every field.)
    expect(globalStore.serverEnv('web')).toEqual({})
    expect(() => globalStore.setServerEnv('web', { A: '1' })).toThrow(/workspace/)
  })
})

/**
 * The backup model offers a server's secrets as their own leaf, so one can be left out.
 *
 * `serverEnv` is a top-level workspace secret, so the existing rule already gives it a leaf. What a
 * person needs beyond that is **per server**: "back this workspace up, but not that one machine's
 * credentials" is a real request, and it is the reason the leaf ids are hierarchical (`workspace:<id>:secrets:server:<id>`)
 * rather than one flat `serverEnv`.
 */
describe('the backup selection for a server\'s secrets', () => {
  it('offers one leaf per server that has values, under the workspace secrets item', async () => {
    const { secretParts } = await import('#src/config/secret-parts')
    const parts = secretParts('workspace', ['telegram', 'serverEnv'])
    const leaf = parts.find(part => part.key === 'serverEnv')
    expect(leaf, 'the workspace secrets item carries it').toBeDefined()
    expect(leaf!.fields).toEqual(['serverEnv'])
  })

  it('carries the values into an archive, and a restore writes them back', async () => {
    const { pickSecrets, parseSecrets, mergeSecrets } = await import('#src/config/secret-parts')
    const source = { serverEnv: { web: { A: '1' }, api: { B: '2' } }, telegram: { tg: 'tok' } }

    // What a backup writes for this leaf: the whole `serverEnv` document, as JSON.
    const picked = pickSecrets(source, ['serverEnv'])
    expect(picked, 'the leaf is captured').not.toBeNull()
    expect(JSON.parse(picked!)).toEqual({ serverEnv: source.serverEnv })

    // A restore merges the archive's carried fields over the live file, by field: `serverEnv` is one
    // field, so the archive's whole document replaces the live one and everything else is untouched.
    const restored = mergeSecrets(
      // `parseSecrets` takes the file's **text**, which is what a restore reads.
      parseSecrets(JSON.stringify({ serverEnv: { stale: { OLD: 'x' } }, telegram: { tg: 'live' } })),
      JSON.parse(picked!) as Record<string, unknown>,
      ['serverEnv'],
    )
    expect(restored.serverEnv, 'the archive\'s servers replace the live set').toEqual(source.serverEnv)
    expect(restored.telegram, 'and a field the archive did not carry is left alone').toEqual({ tg: 'live' })
  })
})
