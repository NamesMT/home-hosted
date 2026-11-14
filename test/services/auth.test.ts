import type { AuthConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    seedAccount(null, secrets, 'a-good-password')

    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('does not treat a corrupt secrets file as an accessible one', async () => {
    const { secrets, file } = await makeAuth()
    seedAccount(null, secrets, 'a-good-password')
    await fs.promises.writeFile(file, '{ not json')

    const reloaded = new SecretsStore(file)
    expect(reloaded.passwordSet).toBe(false)
  })
})

/**
 * Give this panel a way in: an account named `default` holding every scope.
 *
 * The tests used to call `auth.setPassword(...)`, which no longer exists — the credential model is an
 * account now, and creating one is what arms the guard. Keeping it a helper means each test still
 * reads as "a panel somebody can sign in to" rather than as a fixture detail.
 */
function seedAccount(auth: { secrets?: never } | unknown, secrets: SecretsStore, secret: string, options: { id?: string, scopes?: string[], generated?: boolean } = {}): void {
  void auth
  const id = options.id ?? 'default'
  // An existing account is **rotated**, not duplicated: calling `createAccount` twice with one id
  // throws, and a test that meant "the secret changed" must not silently do nothing.
  if (secrets.account(id) !== null) {
    secrets.setAccountSecret(id, secret)
    return
  }
  secrets.createAccount({
    id,
    label: id,
    scopes: (options.scopes ?? ['read', 'lifecycle', 'config', 'admin']) as never,
    secret,
    ...(options.generated === true ? { isDefault: true, keepInitial: true } : {}),
  })
}

describe('auth service', () => {
  it('requires both the switch and a password to be armed', async () => {
    const { auth, secrets } = await makeAuth({ enabled: true })
    expect(auth.isEnabled()).toBe(true)
    expect(auth.isRequired()).toBe(false)

    seedAccount(auth, secrets, 'a-good-password')
    expect(auth.isRequired()).toBe(true)
  })

  it('never sends the first-run secret over the API, and drops it once replaced', async () => {
    const { auth, secrets } = await makeAuth({ enabled: true })

    // What a first boot does: a generated secret, marked as the boot default so the machine can
    // print it and exposure stays blocked.
    seedAccount(auth, secrets, 'abcd-efgh-jkmn', { generated: true })
    expect(auth.usingDefaultPassword).toBe(true)
    // **Absent**, not `null`: a field that is always `null` promised a value that cannot arrive.
    expect(auth.sessionView(false)).not.toHaveProperty('defaultPassword')
    expect(secrets.initialPassword, 'the machine can still read it back').toBe('abcd-efgh-jkmn')

    seedAccount(auth, secrets, 'a-real-password')
    expect(auth.usingDefaultPassword).toBe(false)
    expect(secrets.initialPassword).toBeNull()
  })

  it('still recognises a home on the pre-0.12 shared default', async () => {
    const { secrets } = await makeAuth({ enabled: true })
    seedAccount(null, secrets, 'hh', { generated: true })
    expect(secrets.initialPassword).toBe('hh')
  })

  it('logs in, validates the session and signs out', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')

    const outcome = auth.login('default', 'a-good-password', '127.0.0.1')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok)
      return

    const session = auth.validate(outcome.token)
    expect(session?.ip).toBe('127.0.0.1')

    auth.logout(outcome.token)
    expect(auth.validate(outcome.token)).toBeNull()
  })

  /**
   * The session lifetime is an **idle** timeout, not an absolute one.
   *
   * `validate()` slides `expiresAt` forward on every request, so a session in regular use never
   * expires — measured at 10x the configured lifetime. The login page said "Sessions last 7 days",
   * which reads as the absolute reading, and `SessionRecord.createdAt` was written but never read
   * anywhere, which is the vestige of an absolute cap that was never implemented. The wording now
   * matches the behaviour and this pins the behaviour, so changing either is deliberate.
   */
  it('extends the session on each use, so the lifetime is idle rather than absolute', async () => {
    vi.useFakeTimers()
    try {
      const { auth, secrets } = await makeAuth({ sessionTtlMs: 60_000 })
      seedAccount(auth, secrets, 'a-good-password')
      const outcome = auth.login('default', 'a-good-password', '127.0.0.1')
      if (!outcome.ok)
        throw new Error('login failed')

      // Used every half-lifetime, it outlives its own nominal lifetime several times over.
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(30_000)
        expect(auth.validate(outcome.token), `still valid at step ${i}`).not.toBeNull()
      }

      // Idle for the whole lifetime and it is gone — that is the guarantee it does make.
      vi.advanceTimersByTime(60_001)
      expect(auth.validate(outcome.token), 'idle past the lifetime ends it').toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects a wrong password with 401', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')

    const outcome = auth.login('default', 'nope', '127.0.0.1')
    expect(outcome).toEqual({ ok: false, status: 401, error: 'invalid account id or secret' })
  })

  it('refuses to log in when no account can sign in', async () => {
    const { auth } = await makeAuth()
    const outcome = auth.login('default', 'anything', '127.0.0.1')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.status).toBe(409)
  })

  it('locks out an address after the configured failures and then escalates', async () => {
    const { auth, secrets } = await makeAuth({ maxLoginAttempts: 2, lockoutMs: 60000 })

    seedAccount(auth, secrets, 'a-good-password')
    expect(auth.login('default', 'bad', '10.0.0.1').ok).toBe(false)
    expect(auth.login('default', 'bad', '10.0.0.1').ok).toBe(false)

    const locked = auth.login('default', 'a-good-password', '10.0.0.1')
    expect(locked.ok).toBe(false)
    if (!locked.ok) {
      expect(locked.status).toBe(429)
      expect(locked.retryAfterMs).toBeGreaterThan(0)
    }

    // A different address is unaffected.
    expect(auth.login('default', 'a-good-password', '10.0.0.2').ok).toBe(true)
  })

  /**
   * Rotating one account's secret invalidates **that account's** sessions, and no others.
   *
   * It used to compare every session against the `default` account's timestamp, so any credential
   * change signed the whole panel out — which is wrong for the case accounts exist for: two people,
   * two credentials, one panel.
   */
  it('invalidates the sessions of the account whose secret changed, and no others', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')
    seedAccount(auth, secrets, 'teammate-password', { id: 'teammate', scopes: ['read'] })

    const mine = auth.login('default', 'a-good-password', null)
    const theirs = auth.login('teammate', 'teammate-password', null)
    if (!mine.ok || !theirs.ok)
      throw new Error('login failed')
    expect(auth.validate(mine.token)).not.toBeNull()
    expect(auth.validate(theirs.token)).not.toBeNull()

    // Another process rotating the `default` secret.
    new SecretsStore(secrets.path, undefined, 'global').setAccountSecret('default', 'rotated')
    expect(auth.validate(mine.token), 'the rotated account is signed out').toBeNull()
    expect(auth.validate(theirs.token), 'another account is untouched').not.toBeNull()
  })

  /**
   * A password written by *another process* must invalidate sessions too.
   *
   * `home-hosted set-password` writes the secrets file directly — it cannot reach this process's
   * in-memory sessions — so the old behaviour rotated the hash the panel honoured while every
   * existing cookie stayed valid for up to `sessionTtlMs` (a week by default). Sessions now carry
   * the password revision they were issued under, so any rotation drops them whoever wrote it.
   */
  it('lets another process rotate an account secret without the panel noticing a stale session', async () => {
    const { auth, secrets, file } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')

    const outcome = auth.login('default', 'a-good-password', null)
    if (!outcome.ok)
      throw new Error('could not sign in')
    expect(auth.validate(outcome.token)).not.toBeNull()

    // A second store over the same file is exactly what the CLI is: another process, same state.
    const second = new SecretsStore(file)
    second.setAccountSecret('default', 'written-by-the-cli')

    expect(auth.validate(outcome.token), 'the old cookie must not survive a rotation').toBeNull()
  })

  it('keeps the session that changed the secret, and drops that account\'s others', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')

    const mine = auth.login('default', 'a-good-password', null)
    const other = auth.login('default', 'a-good-password', '10.0.0.9')
    if (!mine.ok || !other.ok)
      throw new Error('could not sign in twice')

    // The service call, because it is what knows which session made the change; a bare store write
    // invalidates both, which is the behaviour the test above pins.
    auth.setAccountSecret('default', 'a-different-password', { keepToken: mine.token })

    expect(auth.validate(mine.token), 'the session that made the change stays').not.toBeNull()
    expect(auth.validate(other.token), 'the account\'s other sessions end').toBeNull()
  })

  /**
   * Revoking an account ends its sessions.
   *
   * The old test called `clearPassword()`, which no longer exists: a credential is an account now, and
   * the way one goes away is revocation. The rule that mattered — a valid cookie must not outlive the
   * credential it was issued for — is asserted directly, and a second account proves only the revoked
   * one is affected.
   */
  it('ends the sessions of the account it revokes, and no others', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')
    seedAccount(auth, secrets, 'another-password', { id: 'teammate', scopes: ['read'] })

    const mine = auth.login('default', 'a-good-password', null)
    const theirs = auth.login('teammate', 'another-password', null)
    if (!mine.ok || !theirs.ok)
      throw new Error('login failed')
    expect(auth.validate(mine.token)).not.toBeNull()
    expect(auth.validate(theirs.token)).not.toBeNull()

    auth.revokeAccount('default')
    expect(auth.validate(mine.token), 'the revoked account is signed out').toBeNull()
    expect(auth.validate(theirs.token), 'another account is untouched').not.toBeNull()
    expect(auth.verifyAccountSecret('default', 'a-good-password'), 'and its secret stops working').toBe(false)
  })

  it('expires a session once the configured lifetime passes', async () => {
    const { auth, secrets } = await makeAuth({ sessionTtlMs: 60000 })
    seedAccount(auth, secrets, 'a-good-password')

    const outcome = auth.login('default', 'a-good-password', null)
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
  it('picks up an account created by another process without a restart', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
    dirs.push(dir)
    const file = path.join(dir, 'secrets.json')

    const live = new SecretsStore(file)
    expect(live.passwordSet).toBe(false)

    // A separate store instance models `home-hosted account create`.
    new SecretsStore(file).createAccount({ id: 'admin', label: 'admin', scopes: ['read', 'admin'], secret: 'a-good-password' })

    expect(live.passwordSet, 'a panel that was up sees the new account').toBe(true)
    expect(live.verifyAccountSecret('admin', 'a-good-password')).toBe(true)
    expect(live.listAccounts().map(entry => entry.id)).toEqual(['admin'])
  })

  it('also notices an account being revoked', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secrets-'))
    dirs.push(dir)
    const file = path.join(dir, 'secrets.json')

    const live = new SecretsStore(file)
    live.createAccount({ id: 'admin', label: 'admin', scopes: ['read'], secret: 'a-good-password' })
    expect(live.passwordSet).toBe(true)

    new SecretsStore(file).revokeAccount('admin')
    expect(live.passwordSet, 'and notices it going away').toBe(false)
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

  /**
   * A bearer credential is a first-class way in — and it is `<id>:<secret>`.
   *
   * The id travels in the credential so the panel never has to ask "which account is this secret
   * for": that would mean comparing every stored hash, which is slower *and* a timing signal. A value
   * with no `:` is refused rather than guessed, so a 0.14 token cannot be silently reinterpreted.
   */
  it('treats a bearer credential as a first-class one', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-script-secret', { id: 'script', scopes: ['read'] })

    expect(auth.apiTokenSet, 'an account can authenticate the API').toBe(true)
    expect(auth.accountFromBearer('script:a-script-secret')).toMatchObject({ id: 'script' })
    expect(auth.accountFromBearer('script:wrong')).toBeNull()
    expect(auth.accountFromBearer('ghost:a-script-secret')).toBeNull()
    // No separator: this is a 0.14 token value, and it must not become an account.
    expect(auth.accountFromBearer('a-script-secret')).toBeNull()
    expect(auth.accountFromBearer(':a-script-secret')).toBeNull()

    const identity = auth.authenticate({ cookieToken: null, bearerToken: 'script:a-script-secret' })
    expect(identity.authenticated).toBe(true)
    expect(identity.method).toBe('token')
    expect(identity.session).toBeNull()
    expect(identity.account?.id).toBe('script')

    expect(auth.authenticate({ cookieToken: null, bearerToken: 'script:not-the-secret' }).authenticated).toBe(false)
  })

  /**
   * A bearer credential survives a **session** rotation, because it is not that account's session.
   *
   * The old rule was that rotating the password did not clear the API token, which is why retiring one
   * was a separate act. With accounts the distinction is cleaner: a session ends when its account's
   * secret changes, and any credential value already in use keeps working until it is revoked.
   */
  it('keeps a bearer credential working across a session rotation', async () => {
    const { auth, secrets } = await makeAuth()
    seedAccount(auth, secrets, 'a-good-password')
    seedAccount(auth, secrets, 'a-script-secret', { id: 'script', scopes: ['read'] })

    const outcome = auth.login('default', 'a-good-password', null)
    if (!outcome.ok)
      throw new Error('login failed')

    seedAccount(auth, secrets, 'a-different-password')
    // The session it was issued under is gone…
    expect(auth.validate(outcome.token)).toBeNull()
    // …and another account's credential is untouched.
    expect(auth.authenticate({ cookieToken: null, bearerToken: 'script:a-script-secret' })).toMatchObject({ authenticated: true, method: 'token' })

    // Revoking the account is the act that retires it.
    auth.revokeAccount('script')
    expect(auth.authenticate({ cookieToken: null, bearerToken: 'script:a-script-secret' }).authenticated).toBe(false)
  })

  it('prefers a live session when a request carries both credentials', async () => {
    const { auth, secrets } = await makeAuth()
    secrets.setApiToken(generateApiToken())
    seedAccount(auth, secrets, 'a-good-password')

    const outcome = auth.login('default', 'a-good-password', null)
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

    // A secrets file with no token at all — written by a release before tokens existed,
    // or simply never set — must read as "none set", never as authenticated.
    await fs.promises.writeFile(file, JSON.stringify({ password: null, telegram: null }))
    const older = new SecretsStore(file)
    expect(older.apiTokenSet).toBe(false)
    expect(older.passwordSet).toBe(false)
  })
})

/**
 * With `trustProxy: true` the per-address key is the leftmost `X-Forwarded-For`, which srvx takes as
 * the client when every hop is trusted — so a new spelling per attempt dodged the per-address
 * lockout and grew the record map until the next minute's sweep.
 */
describe('login limits that do not trust the address', () => {
  async function limited(limits: ConstructorParameters<typeof AuthService>[2]) {
    const { secrets, config } = await makeAuth()
    const auth = new AuthService(secrets, () => config, limits)
    seedAccount(auth, secrets, 'a-good-password')
    return auth
  }

  it('caps the guesses across every address, a correct one included', async () => {
    const auth = await limited({ globalFailureBudget: 3 })
    for (let index = 0; index < 3; index++)
      expect(auth.login('default', 'wrong', `198.51.100.${index}`)).toMatchObject({ ok: false, status: 401 })

    const refused = auth.login('default', 'a-good-password', '198.51.100.99')
    expect(refused).toMatchObject({ ok: false, status: 429 })
    expect((refused as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0)
    auth.dispose()
  })

  it('opens again once the window closes', async () => {
    vi.useFakeTimers()
    try {
      const auth = await limited({ globalFailureBudget: 1, globalFailureWindowMs: 60_000 })
      auth.login('default', 'wrong', '198.51.100.1')
      expect(auth.login('default', 'a-good-password', '198.51.100.2')).toMatchObject({ status: 429 })
      vi.advanceTimersByTime(60_000)
      expect(auth.login('default', 'a-good-password', '198.51.100.2')).toMatchObject({ ok: true })
      auth.dispose()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('bounds the per-address records on insert, not only in the sweep', async () => {
    const auth = await limited({ maxAttemptRecords: 3, globalFailureBudget: 1000 })
    for (let index = 0; index < 10; index++)
      auth.login('default', 'wrong', `203.0.113.${index}`)
    expect(auth.attemptRecords()).toBe(3)
    auth.dispose()
  })
})
