import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DDNS_SECRET, SecretsStore } from '#src/config/secrets'
import { logger } from '#src/helpers/logger'

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

  /**
   * Sealing is what stops a leaked *file* handing over the DNS credentials — under the built-in key the
   * key is the literal `hh`, so anyone holding the file can open it. The docs said so; nothing at
   * runtime did, and a user who never opens `docs/DDNS.md` reasonably reads "AES-256-GCM" as protected.
   *
   * Both directions asserted: a warning on every start would be noise, and there are no credentials to
   * protect until an account exists.
   */
  it('warns once when credentials are sealed under the built-in key', async () => {
    const warnings: string[] = []
    const savedWarn = logger.warn
    logger.warn = ((...args: unknown[]) => { warnings.push(String(args[0])) }) as typeof logger.warn
    try {
      const withDefault = new SecretsStore(await tempFile())
      expect(withDefault.usingDefaultDdnsSecret).toBe(true)
      withDefault.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })
      const aboutSecret = (): number => warnings.filter(line => line.includes('HHOSTED_DDNS_SECRET')).length
      expect(aboutSecret(), 'warned exactly once').toBe(1)

      // A second write must not warn again.
      withDefault.setDdnsCredentials('cf2', 'cloudflare', { apiToken: 'another-token' })
      expect(aboutSecret(), 'still just the once').toBe(1)

      const explicit = new SecretsStore(await tempFile(), 'a-real-secret')
      expect(explicit.usingDefaultDdnsSecret).toBe(false)
      explicit.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })
      expect(aboutSecret(), 'a set secret says nothing').toBe(1)
    }
    finally {
      logger.warn = savedWarn
    }
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

/**
 * The two scopes are the split the layout migration makes: the password hash and
 * the API token hash are panel-wide; the Telegram bot token and DDNS credentials
 * belong to exactly one workspace. A scoped store neither reads nor writes the
 * other half, so a workspace file can never carry the panel's password.
 */
describe('secret scopes', () => {
  it('a global store never persists the workspace half', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's', 'global')

    store.setPassword('a-password')
    store.setApiToken('hh_a-token')
    store.setTelegramToken('bot-token')
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })

    // The panel-wide secrets are there…
    expect(store.passwordSet).toBe(true)
    expect(store.apiTokenSet).toBe(true)
    // …and the workspace half was dropped, even from the write.
    expect(store.telegramToken).toBeNull()
    expect(store.ddnsAccountIds).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).not.toContain('bot-token')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cf-token-value')
    expect(read(file).telegram).toBeNull()
    expect(read(file).ddns).toEqual({})
    expect(read(file).ddnsKdf).toBeNull()
  })

  it('a workspace store never persists the global half', async () => {
    const file = await tempFile()
    const store = new SecretsStore(file, 's', 'workspace')

    store.setTelegramToken('bot-token')
    store.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })
    store.setPassword('a-password')
    store.setApiToken('hh_a-token')

    // The workspace's own secrets are there…
    expect(store.telegramToken).toBe('bot-token')
    expect(store.getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'cf-token-value' })
    // …and the panel-wide half was dropped, never written into the workspace file.
    expect(store.passwordSet).toBe(false)
    expect(store.apiTokenSet).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('a-password')
    expect(read(file).password).toBeNull()
    expect(read(file).apiToken).toBeNull()
  })

  it('a scoped store reads only its own half of a file that carries both', async () => {
    const file = await tempFile()
    const both = new SecretsStore(file, 's', 'all')
    both.setPassword('a-password')
    both.setApiToken('hh_a-token')
    both.setTelegramToken('bot-token')
    both.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'cf-token-value' })

    const global = new SecretsStore(file, 's', 'global')
    expect(global.passwordSet).toBe(true)
    expect(global.apiTokenSet).toBe(true)
    expect(global.telegramToken).toBeNull()
    expect(global.ddnsAccountIds).toEqual([])

    const workspace = new SecretsStore(file, 's', 'workspace')
    expect(workspace.telegramToken).toBe('bot-token')
    expect(workspace.getDdnsCredentials('cf', 'cloudflare')?.values).toEqual({ apiToken: 'cf-token-value' })
    expect(workspace.passwordSet).toBe(false)
    expect(workspace.apiTokenSet).toBe(false)
  })

  it('a global store leaves the all-scope file it reads intact on a write', async () => {
    const file = await tempFile()
    // A backup archive carries the all-in-one shape; a global store opening it must
    // still be able to read the password without the workspace half leaking back in.
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      password: null,
      apiToken: null,
      telegram: { botToken: 'bot-token' },
      ddns: { cf: { provider: 'cloudflare', values: { apiToken: 'cf-token-value' } } },
    }, null, 2))

    const global = new SecretsStore(file, 's', 'global')
    global.setPassword('a-password')

    // The workspace half is not echoed back through a global write.
    expect(read(file).telegram ?? null).toBeNull()
    expect(read(file).ddns ?? {}).toEqual({})
  })
})
