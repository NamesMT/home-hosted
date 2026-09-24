import type { SecretsStore } from '#src/config/secrets'
import type { AuthConfig, SessionView } from '#src/shared/contracts'
import crypto from 'node:crypto'
import { verifyApiToken, verifyPassword } from '#src/config/secrets'
import { parseCookies } from '#src/helpers/cookies'

export const SESSION_COOKIE = 'hh2_session'

/** Created on first boot when no password exists; exposure stays blocked until it changes. */
export const DEFAULT_PASSWORD = 'hh'

const MAX_SESSIONS = 100
const MAX_LOCKOUT_MS = 15 * 60_000
/** Bounds on the per-IP bookkeeping, which an attacker can otherwise grow. */
const MAX_ATTEMPT_RECORDS = 10_000
const ATTEMPT_RECORD_TTL_MS = 60 * 60_000

export interface SessionRecord {
  token: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  ip: string | null
}

interface AttemptRecord {
  failures: number
  blockedUntil: number
  blocks: number
  /** For expiring idle records: with `trustProxy` the key is client-chosen. */
  lastAttemptAt: number
}

export type LoginOutcome
  = | { ok: true, status: 200, token: string, maxAgeMs: number }
    | { ok: false, status: 401 | 409 | 429, error: string, retryAfterMs?: number }

/** Which credential a request presented. */
export type AuthMethod = 'cookie' | 'token'

export interface AuthIdentity {
  authenticated: boolean
  method: AuthMethod | null
  /** The session record, when the cookie resolved to one. */
  session: SessionRecord | null
}

export const ANONYMOUS: AuthIdentity = { authenticated: false, method: null, session: null }

/**
 * `Authorization: Bearer <token>`; the scheme is case-insensitive per RFC 7235,
 * and the credential is taken whole so a stray space cannot silently shorten it.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header)
    return null
  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'bearer')
    return null
  const token = rest.join('')
  return token.length > 0 ? token : null
}

/**
 * Authentication for the control panel.
 *
 * Two credentials are accepted: the browser's session cookie, and a long-lived
 * API token for scripts and agents. They carry the same authority on purpose —
 * a token that could do less than a signed-in browser would only be surprising.
 *
 * The password hash lives in the git-ignored secrets file; sessions live only in
 * memory, so restarting `up` invalidates every session, while a token outlives
 * the process until it is cleared.
 */
export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly attempts = new Map<string, AttemptRecord>()
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly secrets: SecretsStore,
    private readonly getConfig: () => AuthConfig,
  ) {
    this.timer = setInterval(() => this.cleanup(), 60_000)
    this.timer.unref()
  }

  get passwordSet(): boolean {
    return this.secrets.passwordSet
  }

  get passwordUpdatedAt(): number | null {
    return this.secrets.passwordUpdatedAt
  }

  /** Still the boot-time default: the login page says so, exposure stays blocked. */
  get usingDefaultPassword(): boolean {
    return this.secrets.usingDefaultPassword
  }

  /** The feature is on. */
  isEnabled(): boolean {
    return this.getConfig().enabled
  }

  /** A password is set, so a browser has something to sign in with. */
  isArmed(): boolean {
    return this.getConfig().enabled && this.secrets.passwordSet
  }

  /** Kept as the "should the guard demand a session" predicate. */
  isRequired(): boolean {
    return this.isArmed()
  }

  get apiTokenSet(): boolean {
    return this.secrets.apiTokenSet
  }

  /** The readable head of the stored token, never the token itself. */
  get apiTokenHint(): string | null {
    return this.secrets.apiTokenHint
  }

  /** Compared against the stored SHA-256, in constant time. */
  validateApiToken(token: string | null): boolean {
    if (token === null)
      return false
    const record = this.secrets.apiToken
    if (record === null)
      return false
    return verifyApiToken(token, record)
  }

  /**
   * Resolves whichever credential the request carried. The token is only
   * consulted when no session matched, so a stale cookie cannot mask it.
   */
  authenticate(credentials: { cookieToken: string | null, bearerToken: string | null }): AuthIdentity {
    const session = this.validate(credentials.cookieToken)
    if (session !== null)
      return { authenticated: true, method: 'cookie', session }
    if (this.validateApiToken(credentials.bearerToken))
      return { authenticated: true, method: 'token', session: null }
    return ANONYMOUS
  }

  sessionView(authenticated: boolean): SessionView {
    return {
      authenticated,
      authRequired: this.isRequired(),
      passwordSet: this.secrets.passwordSet,
      apiTokenSet: this.secrets.apiTokenSet,
      usingDefaultPassword: this.secrets.usingDefaultPassword,
      defaultPassword: this.secrets.usingDefaultPassword ? DEFAULT_PASSWORD : null,
      sessionTtlMs: this.getConfig().sessionTtlMs,
    }
  }

  tokenFromCookie(cookieHeader: string | null | undefined): string | null {
    return parseCookies(cookieHeader)[SESSION_COOKIE] ?? null
  }

  /** Sliding expiry: an active panel stays logged in, an idle one does not. */
  validate(token: string | null): SessionRecord | null {
    if (!token)
      return null
    const session = this.sessions.get(token)
    if (!session)
      return null

    const now = Date.now()
    if (session.expiresAt <= now) {
      this.sessions.delete(token)
      return null
    }

    session.lastSeenAt = now
    session.expiresAt = now + this.getConfig().sessionTtlMs
    return session
  }

  verifyCurrentPassword(password: string): boolean {
    const record = this.secrets.password
    if (record === null)
      return false
    return verifyPassword(password, record)
  }

  login(password: string, ip: string | null): LoginOutcome {
    const config = this.getConfig()
    const key = ip ?? 'unknown'
    const now = Date.now()
    const attempt = this.attempts.get(key)

    if (attempt && attempt.blockedUntil > now) {
      const retryAfterMs = attempt.blockedUntil - now
      return {
        ok: false,
        status: 429,
        error: `too many failed attempts, retry in ${Math.ceil(retryAfterMs / 1000)}s`,
        retryAfterMs,
      }
    }

    const record = this.secrets.password
    if (record === null) {
      return { ok: false, status: 409, error: 'no password is set yet' }
    }

    if (!verifyPassword(password, record)) {
      const failures = (attempt?.failures ?? 0) + 1
      if (failures >= config.maxLoginAttempts) {
        const blocks = (attempt?.blocks ?? 0) + 1
        const blockedUntil = Date.now() + Math.min(config.lockoutMs * 2 ** (blocks - 1), MAX_LOCKOUT_MS)
        this.attempts.set(key, { failures: 0, blockedUntil, blocks, lastAttemptAt: Date.now() })
      }
      else {
        this.attempts.set(key, { failures, blockedUntil: 0, blocks: attempt?.blocks ?? 0, lastAttemptAt: Date.now() })
      }
      return { ok: false, status: 401, error: 'invalid password' }
    }

    this.attempts.delete(key)
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (oldest)
        this.sessions.delete(oldest.token)
    }

    const token = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(token, {
      token,
      createdAt: now,
      expiresAt: now + config.sessionTtlMs,
      lastSeenAt: now,
      ip,
    })

    return { ok: true, status: 200, token, maxAgeMs: config.sessionTtlMs }
  }

  logout(token: string | null): void {
    if (token)
      this.sessions.delete(token)
  }

  logoutAll(): void {
    this.sessions.clear()
  }

  /**
   * Changing the password must not leave old sessions valid. The session that
   * made the change is kept — being signed out of the page you just used is not
   * a security requirement, and it makes a successful change look like a failure.
   */
  setPassword(password: string, options: { isDefault?: boolean, keepToken?: string | null } = {}): void {
    this.secrets.setPassword(password, options)
    this.logoutOthers(options.keepToken ?? null)
  }

  /** Drops every session except one, which is how a password change stays signed in. */
  private logoutOthers(keep: string | null): void {
    if (keep === null) {
      this.sessions.clear()
      return
    }
    for (const token of [...this.sessions.keys()]) {
      if (token !== keep)
        this.sessions.delete(token)
    }
  }

  /** Creates the boot-time default only when nothing is set yet. */
  ensureDefaultPassword(password: string): boolean {
    const created = this.secrets.ensureDefaultPassword(password) !== null
    if (created)
      this.logoutAll()
    return created
  }

  clearPassword(): void {
    this.secrets.clearPassword()
    this.logoutAll()
  }

  activeSessions(): number {
    return this.sessions.size
  }

  dispose(): void {
    clearInterval(this.timer)
    this.sessions.clear()
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now)
        this.sessions.delete(token)
    }
    for (const [key, attempt] of this.attempts) {
      // Idle records go, whether or not they were ever blocked — a failed login
      // from an address that never comes back must not be remembered forever.
      if (now - attempt.lastAttemptAt >= ATTEMPT_RECORD_TTL_MS)
        this.attempts.delete(key)
    }

    if (this.attempts.size > MAX_ATTEMPT_RECORDS) {
      const oldest = [...this.attempts.entries()]
        .sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt)
        .slice(0, this.attempts.size - MAX_ATTEMPT_RECORDS)
      for (const [key] of oldest) this.attempts.delete(key)
    }
  }
}
