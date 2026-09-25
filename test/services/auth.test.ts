import type { AuthConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenRecord, generateApiToken, hashPassword, SecretsStore, verifyApiToken, verifyPassword } from '#src/config/secrets'
import { AuthService, bearerToken } from '#src/services/auth'
import { authSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeAuth(overrides: Partial<AuthConfig> = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-auth-'))
  dirs.push(dir)
  const file = path.join(dir, 'secrets.json')
  const secrets = new SecretsStore(file)

  const parsed = authSchema({ enabled: true, ...overrides })
  if (parsed instanceof type.errors)
    throw parsed
  const auth = new AuthService(secrets, () => parsed)

  return { auth, secrets, file, config: parsed }
}

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', () => {
    const record = hashPassword('correct horse battery staple')
    expect(record.algo).toBe('scrypt')
    expect(verifyPassword('correct horse battery staple', record)).toBe(true)
    expect(verifyPassword('correct horse battery stapl', record)).toBe(false)
    expect(verifyPassword('', record)).toBe(false)
  })

  it('salts every hash, so identical passwords differ on disk', () => {
    const a = hashPassword('same password')
    const b = hashPassword('same password')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(verifyPassword('same password', a)).toBe(true)
    expect(verifyPassword('same password', b)).toBe(true)
  })

  it('normalises unicode so the same typed password verifies', () => {
    const record = hashPassword('pässwörd-with-composed-é')
    expect(verifyPassword('pässwörd-with-composed-é'.normalize('NFC'), record)).toBe(true)
  })

  // NTFS has no POSIX mode bits: Node reports a fixed 0o666/0o444 there whatever
  // `mode` the write asked for, so this can only be asserted where it means something.
  it.skipIf(process.platform === 'win32')('writes the secrets file with mode 0600', async () => {
    const { secrets, file } = await makeAuth()
    secrets.setPassword('a-good-password')

    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('does not treat a corrupt secrets file as an accessible one', async () => {
    const { secrets, file } = await makeAuth()
    secrets.setPassword('a-good-password')
    await fs.promises.writeFile(file, '{ not json')

    const reloaded = new SecretsStore(file)
    expect(reloaded.passwordSet).toBe(false)
  })
})

describe('auth service', () => {
  it('requires both the switch and a password to be armed', async () => {
    const { auth } = await makeAuth({ enabled: true })
    expect(auth.isEnabled()).toBe(true)
    expect(auth.isRequired()).toBe(false)

    auth.setPassword('a-good-password')
    expect(auth.isRequired()).toBe(true)
  })

  it('logs in, validates the session and signs out', async () => {
    const { auth } = await makeAuth()
    auth.setPassword('a-good-password')

    const outcome = auth.login('a-good-password', '127.0.0.1')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok)
      return

    const session = auth.validate(outcome.token)
    expect(session?.ip).toBe('127.0.0.1')

    auth.logout(outcome.token)
    expect(auth.validate(outcome.token)).toBeNull()
  })

  it('rejects a wrong password with 401', async () => {
    const { auth } = await makeAuth()
    auth.setPassword('a-good-password')

    const outcome = auth.login('nope', '127.0.0.1')
    expect(outcome).toEqual({ ok: false, status: 401, error: 'invalid password' })
  })

  it('refuses to log in before a password exists', async () => {
    const { auth } = await makeAuth()
    const outcome = auth.login('anything', '127.0.0.1')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.status).toBe(409)
  })

  it('locks out an address after the configured failures and then escalates', async () => {
    const { auth } = await makeAuth({ maxLoginAttempts: 2, lockoutMs: 60000 })

    auth.setPassword('a-good-password')
    expect(auth.login('bad', '10.0.0.1').ok).toBe(false)
    expect(auth.login('bad', '10.0.0.1').ok).toBe(false)

    const locked = auth.login('a-good-password', '10.0.0.1')
    expect(locked.ok).toBe(false)
    if (!locked.ok) {
      expect(locked.status).toBe(429)
      expect(locked.retryAfterMs).toBeGreaterThan(0)
    }

    // A different address is unaffected.
    expect(auth.login('a-good-password', '10.0.0.2').ok).toBe(true)
  })

  it('invalidates every session when the password changes', async () => {
    const { auth } = await makeAuth()
    auth.setPassword('a-good-password')

    const outcome = auth.login('a-good-password', null)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok)
      return
    expect(auth.validate(outcome.token)).not.toBeNull()

    auth.setPassword('a-different-password')
    expect(auth.validate(outcome.token)).toBeNull()
  })

  it('keeps the session that changed the password, and drops the others', async () => {
    const { auth } = await makeAuth()
    auth.setPassword('a-good-password')

    const mine = auth.login('a-good-password', null)
    const other = auth.login('a-good-password', '10.0.0.9')
    if (!mine.ok || !other.ok)
      throw new Error('could not sign in twice')

    auth.setPassword('a-different-password', { keepToken: mine.token })

    expect(auth.validate(mine.token)).not.toBeNull()
    expect(auth.validate(other.token)).toBeNull()
  })

  it('clears the password and the sessions', async () => {
    const { auth } = await makeAuth()
    auth.setPassword('a-good-password')
    const outcome = auth.login('a-good-password', null)
    if (!outcome.ok)
      throw new Error('login failed')

    auth.clearPassword()
    expect(auth.passwordSet).toBe(false)
    expect(auth.isRequired()).toBe(false)
    expect(auth.validate(outcome.token)).toBeNull()
    expect(auth.verifyCurrentPassword('a-good-password')).toBe(false)
  })

  it('expires a session once the configured lifetime passes', async () => {
    const { auth } = await makeAuth({ sessionTtlMs: 60000 })
    auth.setPassword('a-good-password')

    const outcome = auth.login('a-good-password', null)
    if (!outcome.ok)
      throw new Error('login failed')

    const session = auth.validate(outcome.token)
    expect(session).not.toBeNull()
    // Sliding expiry pushes the deadline out on each use.
    if (session)
      session.expiresAt = Date.now() - 1
    expect(auth.validate(outcome.token)).toBeNull()
  })
})

describe('secrets store', () => {
  it('picks up a password written by another process without a restart', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
    dirs.push(dir)
    const file = path.join(dir, 'secrets.json')

    const live = new SecretsStore(file)
    expect(live.passwordSet).toBe(false)

    // A separate store instance models the `set-password` script.
    new SecretsStore(file).setPassword('a-good-password')

    expect(live.passwordSet).toBe(true)
    const record = live.password
    expect(record).not.toBeNull()
    expect(record && verifyPassword('a-good-password', record)).toBe(true)
  })

  it('also notices the password being removed', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
    dirs.push(dir)
    const file = path.join(dir, 'secrets.json')

    const live = new SecretsStore(file)
    live.setPassword('a-good-password')
    expect(live.passwordSet).toBe(true)

    new SecretsStore(file).clearPassword()
    expect(live.passwordSet).toBe(false)
  })
})

describe('api tokens', () => {
  it('generates a prefixed, url-safe token every time', () => {
    const first = generateApiToken()
    const second = generateApiToken()

    expect(first.startsWith('hh_')).toBe(true)
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(30)
    expect(first).toMatch(/^[\w-]+$/)
  })

  it('verifies only the token it hashed, and never stores it readably', () => {
    const record = apiTokenRecord('hh_secret-value')

    expect(verifyApiToken('hh_secret-value', record)).toBe(true)
    expect(verifyApiToken('hh_secret-valu3', record)).toBe(false)
    expect(verifyApiToken('', record)).toBe(false)
    expect(record.hint).toBe('hh_secre')
    expect(record.hash).not.toContain('secret-value')
  })

  it('refuses a corrupt token hash instead of throwing on every request', () => {
    const record = apiTokenRecord('hh_secret-value')

    // A hand-edited or truncated secrets file used to make the auth guard throw
    // RangeError, which turned every /api request into a 500.
    expect(verifyApiToken('hh_secret-value', { ...record, hash: record.hash.slice(0, 8) })).toBe(false)
    expect(verifyApiToken('hh_secret-value', { ...record, hash: '' })).toBe(false)
  })

  it('reads the Authorization header, header scheme included', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123')
    expect(bearerToken('bearer   abc123  ')).toBe('abc123')
    expect(bearerToken('Token abc123')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })

  it('treats the token as a first-class credential', async () => {
    const { auth, secrets } = await makeAuth()
    const token = generateApiToken()
    secrets.setApiToken(token)

    expect(auth.apiTokenSet).toBe(true)
    expect(auth.apiTokenHint).toBe(token.slice(0, 8))
    expect(auth.validateApiToken(token)).toBe(true)
    expect(auth.validateApiToken(generateApiToken())).toBe(false)
    expect(auth.validateApiToken(null)).toBe(false)

    const identity = auth.authenticate({ cookieToken: null, bearerToken: token })
    expect(identity.authenticated).toBe(true)
    expect(identity.method).toBe('token')
    expect(identity.session).toBeNull()

    expect(auth.authenticate({ cookieToken: null, bearerToken: 'not-the-token' }).authenticated).toBe(false)
  })

  it('prefers a live session when a request carries both credentials', async () => {
    const { auth, secrets } = await makeAuth()
    secrets.setApiToken(generateApiToken())
    auth.setPassword('a-good-password')

    const outcome = auth.login('a-good-password', null)
    if (!outcome.ok)
      throw new Error('login failed')

    const identity = auth.authenticate({ cookieToken: outcome.token, bearerToken: secrets.apiToken?.hint ?? null })
    expect(identity.method).toBe('cookie')
    expect(identity.session?.token).toBe(outcome.token)
  })

  it('reports the token as a flag, never as a value', async () => {
    const { auth, secrets } = await makeAuth()
    expect(auth.sessionView(false).apiTokenSet).toBe(false)

    const token = generateApiToken()
    secrets.setApiToken(token)
    const view = auth.sessionView(true)

    expect(view.apiTokenSet).toBe(true)
    expect(view.authenticated).toBe(true)
    expect(JSON.stringify(view)).not.toContain(token)
  })

  it('writes a file that never contains the token itself', async () => {
    const { secrets, file } = await makeAuth()
    const token = generateApiToken()
    secrets.setApiToken(token)

    const raw = await fs.promises.readFile(file, 'utf8')
    expect(raw).toContain('"apiToken"')
    expect(raw).not.toContain(token)
  })

  it.skipIf(process.platform === 'win32')('writes that token file with mode 0600', async () => {
    const { secrets, file } = await makeAuth()
    secrets.setApiToken(generateApiToken())
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('clears the token so it stops authenticating', async () => {
    const { auth, secrets } = await makeAuth()
    const token = generateApiToken()
    secrets.setApiToken(token)

    secrets.clearApiToken()
    expect(auth.apiTokenSet).toBe(false)
    expect(auth.validateApiToken(token)).toBe(false)
  })

  it('picks up a token written by another process, and tolerates an older file', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
    dirs.push(dir)
    const file = path.join(dir, 'secrets.json')

    const live = new SecretsStore(file)
    expect(live.apiTokenSet).toBe(false)

    // A separate instance models `home-hosted set-token` running alongside `up`.
    new SecretsStore(file).setApiToken('hh_written-elsewhere')
    expect(live.apiTokenSet).toBe(true)
    const record = live.apiToken
    expect(record).not.toBeNull()
    if (record)
      expect(verifyApiToken('hh_written-elsewhere', record)).toBe(true)

    // A version-2 file predates tokens entirely, so it must read as "none set".
    await fs.promises.writeFile(file, JSON.stringify({ version: 2, password: null, telegram: null }))
    const older = new SecretsStore(file)
    expect(older.apiTokenSet).toBe(false)
    expect(older.passwordSet).toBe(false)
  })
})
