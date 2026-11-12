import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenRecord, generateApiToken, SecretsStore, verifyApiToken } from '#src/config/secrets'

/**
 * Multiple named, scoped API tokens — and the old single token migrating to one of them.
 *
 * Today there is one token and it is full admin. That is the right shape for a single script and the
 * wrong one for a homelab: a monitor that only reads, a deploy hook that only restarts, and a phone
 * widget that only looks, all have to hold the same credential — and history cannot tell them apart,
 * because every token action is labelled `'agent'`.
 *
 * Two invariants carry the security:
 *  - only a **hash** is stored, compared in constant time like the single token was;
 *  - the existing token becomes one token named `default` with `['admin']` and no workspace limit, so
 *    nothing breaks on upgrade.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-tokens-'))
  dirs.push(dir)
  return dir
}

async function store(): Promise<SecretsStore> {
  const dir = await scratch()
  return new SecretsStore(path.join(dir, '.control-secrets.json'), undefined, 'global')
}

describe('the API token store', () => {
  it('mints a token, keeps only its hash, and verifies it', async () => {
    const secrets = await store()
    const { token, record } = secrets.createApiToken({ name: 'monitor', scopes: ['read'] })

    expect(token, 'the token is returned once').toMatch(/^hh_/)
    const raw = fs.readFileSync(secrets.path, 'utf8')
    expect(raw, 'the file keeps a hash, never the token').not.toContain(token)
    expect(raw).toContain(record.id)

    const found = secrets.findApiToken(token)
    expect(found).toMatchObject({ name: 'monitor', scopes: ['read'] })
    // And the stored record still verifies, in constant time.
    expect(verifyApiToken(token, apiTokenRecord(token))).toBe(true)
  })

  it('refuses a token it does not know', async () => {
    const secrets = await store()
    secrets.createApiToken({ name: 'monitor', scopes: ['read'] })
    expect(secrets.findApiToken(generateApiToken())).toBeNull()
    expect(secrets.findApiToken('')).toBeNull()
    expect(secrets.findApiToken('not-a-token')).toBeNull()
  })

  it('lists tokens without their secrets', async () => {
    const secrets = await store()
    const { token } = secrets.createApiToken({ name: 'monitor', scopes: ['read'] })
    const listed = secrets.listApiTokens()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'monitor', scopes: ['read'] })
    // No hash, no token: a listing is metadata.
    expect(JSON.stringify(listed)).not.toContain(token)
    expect(listed[0]).not.toHaveProperty('hash')
  })

  it('revokes one by id, and refuses an unknown one', async () => {
    const secrets = await store()
    const first = secrets.createApiToken({ name: 'one', scopes: ['read'] })
    const second = secrets.createApiToken({ name: 'two', scopes: ['admin'] })

    expect(secrets.revokeApiToken(first.record.id)).toBe(true)
    expect(secrets.findApiToken(first.token), 'a revoked token stops working').toBeNull()
    expect(secrets.findApiToken(second.token), 'and the other keeps working').toBeTruthy()
    expect(secrets.revokeApiToken('nope')).toBe(false)
  })

  it('refuses a duplicate name, so two tokens are distinguishable', async () => {
    const secrets = await store()
    secrets.createApiToken({ name: 'monitor', scopes: ['read'] })
    expect(() => secrets.createApiToken({ name: 'monitor', scopes: ['admin'] })).toThrow(/already/)
  })

  it('records when a token was last used', async () => {
    const secrets = await store()
    const { token, record } = secrets.createApiToken({ name: 'monitor', scopes: ['read'] })
    expect(record.lastUsedAt).toBeUndefined()

    secrets.markApiTokenUsed(record.id)
    const listed = secrets.listApiTokens().find(entry => entry.id === record.id)!
    expect(listed.lastUsedAt).toBeTypeOf('number')
    // Marking does not change which token is which.
    expect(secrets.findApiToken(token)).toMatchObject({ name: 'monitor' })
  })
})

describe('migrating the single token', () => {
  it('becomes one token named default with admin and no workspace limit', async () => {
    const dir = await scratch()
    const file = path.join(dir, '.control-secrets.json')
    const legacy = generateApiToken()
    // A file written by an older release: `apiToken` and nothing else.
    fs.writeFileSync(file, JSON.stringify({ version: 1, apiToken: apiTokenRecord(legacy) }), { mode: 0o600 })

    const secrets = new SecretsStore(file, undefined, 'global')
    const [migrated] = secrets.listApiTokens()
    expect(migrated).toMatchObject({ name: 'default', scopes: ['admin'] })
    expect(migrated!.workspaces, 'an old token was not workspace-limited').toBeUndefined()
    // The old value still works — this is the whole "nothing breaks" promise.
    expect(secrets.findApiToken(legacy)).toMatchObject({ name: 'default' })
  })

  it('does not resurrect the legacy field after a revoke', async () => {
    const dir = await scratch()
    const file = path.join(dir, '.control-secrets.json')
    const legacy = generateApiToken()
    fs.writeFileSync(file, JSON.stringify({ version: 1, apiToken: apiTokenRecord(legacy) }), { mode: 0o600 })

    const secrets = new SecretsStore(file, undefined, 'global')
    const [migrated] = secrets.listApiTokens()
    secrets.revokeApiToken(migrated!.id)

    // A second read must not re-migrate the old field: it is gone from disk once written.
    const reopened = new SecretsStore(file, undefined, 'global')
    expect(reopened.listApiTokens()).toEqual([])
    expect(reopened.findApiToken(legacy)).toBeNull()
  })
})
