import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DDNS_SECRET, SecretsStore } from '#src/config/secrets'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
  dirs.push(dir)
  return path.join(dir, '.control-secrets.json')
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('ddns credentials at rest', () => {
  it('round-trips, and leaves no plaintext in the file', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 'a-real-secret')
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })

    expect(store.getDdnsCredentials('cf', 'cloudflare')).toEqual({ provider: 'cloudflare', values: { apiToken: 'cf-token-value' } })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('cf-token-value')
    expect(raw).not.toContain('cloudflare')
    expect(read(file).ddns.cf.algo).toBe('aes-256-gcm')
    expect(read(file).ddnsKdf.algo).toBe('scrypt')
  })

  it('reads back with a fresh store, using the same secret', async () => {
    const file = await tempFile()
    new SecretsStore(file, 'shared-secret').setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })
    expect(new SecretsStore(file, 'shared-secret').getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'x' })
  })

  it('returns nothing when the secret changed', async () => {
    const file = await tempFile()
    new SecretsStore(file, 'first').setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })
    expect(new SecretsStore(file, 'second').getDdnsCredentials('cf', 'cloudflare')).toBeNull()
    // The entry survives; only the key is missing.
    expect(read(file).ddns.cf.algo).toBe('aes-256-gcm')
  })

  it('returns nothing when the ciphertext was edited', async () => {
    const file = await tempFile()
    new SecretsStore(file, 's').setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })

    const contents = read(file)
    const data = contents.ddns.cf.data as string
    contents.ddns.cf.data = `${data.slice(0, -4)}AAAA`
    fs.writeFileSync(file, JSON.stringify(contents, null, 2))

    expect(new SecretsStore(file, 's').getDdnsCredentials('cf', 'cloudflare')).toBeNull()
  })

  it('refuses a sealed entry moved to another account id', async () => {
    const file = await tempFile()
    new SecretsStore(file, 's').setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })

    const contents = read(file)
    contents.ddns.stolen = contents.ddns.cf
    delete contents.ddns.cf
    fs.writeFileSync(file, JSON.stringify(contents, null, 2))

    // The account id is authenticated as part of the ciphertext.
    expect(new SecretsStore(file, 's').getDdnsCredentials('stolen', 'cloudflare')).toBeNull()
  })

  it('ignores an entry stored for another provider', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's')
    store.setDdnsCredentials('cf', 'namecheap', { password: 'pw' })

    expect(store.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
    expect(store.getDdnsCredentials('cf', 'namecheap')?.values).toEqual({ password: 'pw' })
  })

  it('forgets an account when every field is cleared', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's')
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: '' })

    expect(store.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
    expect(read(file).ddns.cf).toBeUndefined()
  })

  it('drops every account the caller does not keep', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's')
    store.setDdnsCredentials('a', 'cloudflare', { apiToken: '1' })
    store.setDdnsCredentials('b', 'cloudflare', { apiToken: '2' })

    expect(store.pruneDdnsCredentials(['a'])).toBe(1)
    expect(store.ddnsAccountIds).toEqual(['a'])
    expect(store.pruneDdnsCredentials(['a'])).toBe(0)
  })

  it('defaults the secret so a first run is still sealed', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file)
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })

    expect(DEFAULT_DDNS_SECRET).toBe('hh')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cf-token-value')
    expect(new SecretsStore(file).getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'cf-token-value' })
  })
})

describe('ddns credentials from an older file', () => {
  it('reads a bare field map, and seals it on the next write', async () => {
    const file = await tempFile()
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      password: null,
      apiToken: null,
      telegram: null,
      ddns: { cf: { apiToken: 'legacy-token' } },
    }, null, 2))

    const store = new SecretsStore(file, 's')
    // No provider recorded: accepted for whatever the account declares.
    expect(store.getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'legacy-token' })

    store.setPassword('a-password')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('legacy-token')
    expect(read(file).ddns.cf.algo).toBe('aes-256-gcm')
    expect(new SecretsStore(file, 's').getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'legacy-token' })
  })

  it('reads a plaintext entry that already carries its provider', async () => {
    const file = await tempFile()
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      password: null,
      apiToken: null,
      telegram: null,
      ddns: { cf: { provider: 'namecheap', values: { password: 'pw' } } },
    }, null, 2))

    const store = new SecretsStore(file, 's')
    expect(store.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
    expect(store.getDdnsCredentials('cf', 'namecheap')?.values).toEqual({ password: 'pw' })
  })

  it('keeps the other secrets readable while the ddns entries are sealed', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's')
    store.setPassword('a-password')
    store.setTelegramToken('bot-token')
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'x' })

    expect(read(file).password.algo).toBe('scrypt')
    expect(read(file).telegram.botToken).toBe('bot-token')
    expect(new SecretsStore(file, 'different').passwordSet).toBe(true)
  })
})
