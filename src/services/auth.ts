import type { AccountRecord, ApiTokenScope, SecretsStore } from '#src/config/secrets'
import type { AccountView, AuthConfig, SessionView } from '#src/shared/contracts'
import crypto from 'node:crypto'
import { accountIdProblem, API_TOKEN_SCOPES } from '#src/config/secrets'
import { parseCookies } from '#src/helpers/cookies'

export const SESSION_COOKIE = 'hh_session'

const MAX_SESSIONS = 100
const MAX_LOCKOUT_MS = 15 * 60_000
/** Bounds on the per-IP bookkeeping, which an attacker can otherwise grow. */
const MAX_ATTEMPT_RECORDS = 10_000
const ATTEMPT_RECORD_TTL_MS = 60 * 60_000
/**
 * Failed logins the whole panel tolerates per window, whoever they claim to come from. With
 * `trustProxy: true` the per-address key is the leftmost `X-Forwarded-For`, which the client
 * chooses — a new value per attempt dodged the per-address lockout entirely. This caps guessing
 * however the address is spelled; an honest person never comes near it.
 */
const GLOBAL_FAILURE_BUDGET = 100
const GLOBAL_FAILURE_WINDOW_MS = 10 * 60_000

export interface AuthLimits {
  maxAttemptRecords?: number
  globalFailureBudget?: number
  globalFailureWindowMs?: number
}

export interface SessionRecord {
  token: string
  /**
   * The account this session was issued for.
   *
   * A session belongs to an account, not to "the panel": scopes come from it, and revoking the
   * account must end the session it issued even while the cookie is still valid.
   */
  accountId: string
  /**
   * The `updatedAt` of the password this session was issued under.
   *
   * Sessions live in this process's memory, so a password written by *another* process — the
   * `set-password` CLI, which writes the secrets file directly — was invisible here: it rotated
   * the hash the panel honoured while every existing cookie stayed valid for up to `sessionTtlMs`.
   * Stamping the revision on the session makes any rotation invalidate it, whoever wrote it.
   */
  passwordRevision: number | null
  /**
   * Slid forward on every validated request, so this is an **idle** timeout — `sessionTtlMs` after the
   * last visit, not after login. There is deliberately no absolute cap; the login page says so.
   */
  expiresAt: number
  /**
   * The deadline the browser's cookie was last told about.
   *
   * `expiresAt` slides on every request, but a cookie is only re-sent when something sets it — so
   * without this the browser deleted the cookie `sessionTtlMs` after *login* while the server kept
   * a perfectly good session, and a panel in constant use still signed its owner out.
   */
  cookieExpiresAt: number
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
  /**
   * The account that answered, whichever credential carried it — its scopes and workspace limit.
   *
   * On the identity rather than re-derived per route: one read of the credential, one answer, so the
   * scope middleware, `requestActor` and `GET /api/meta` cannot disagree about who is asking. A
   * cookie and a bearer credential resolve to the same shape, which is the point of an account.
   */
  account?: AccountRecord
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
  private readonly listeners = new Set<() => void>()
  private readonly timer: NodeJS.Timeout
  private readonly limits: Required<AuthLimits>
  /** Failures across every address in the current window, and when that window opened. */
  private globalFailures = { count: 0, windowStart: 0 }

  constructor(
    private readonly secrets: SecretsStore,
    private readonly getConfig: () => AuthConfig,
    limits: AuthLimits = {},
  ) {
    this.limits = {
      maxAttemptRecords: limits.maxAttemptRecords ?? MAX_ATTEMPT_RECORDS,
      globalFailureBudget: limits.globalFailureBudget ?? GLOBAL_FAILURE_BUDGET,
      globalFailureWindowMs: limits.globalFailureWindowMs ?? GLOBAL_FAILURE_WINDOW_MS,
    }
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

  /** Shorter than the exposure bar: the panel stays on loopback until it is changed. */
  get passwordTooShort(): boolean {
    return this.secrets.passwordTooShort
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

  /**
   * Compared against every stored SHA-256, in constant time.
   *
   * Not just the legacy single record: that is one token of several now, and a getter that answered
   * "no" for a named one would say a valid credential is invalid. `findApiToken` compares all of
   * them, so the work does not depend on which token was presented.
   */
  validateApiToken(token: string | null): boolean {
    if (token === null)
      return false
    return this.secrets.findApiToken(token) !== null
  }

  /**
   * Resolves whichever credential the request carried. The token is only
   * consulted when no session matched, so a stale cookie cannot mask it.
   */
  authenticate(credentials: { cookieToken: string | null, bearerToken: string | null }, options: { slide?: boolean } = {}): AuthIdentity {
    const session = this.validate(credentials.cookieToken, options)
    if (session !== null)
      return { authenticated: true, method: 'cookie', session }
    const account = credentials.bearerToken === null ? null : this.accountFromBearer(credentials.bearerToken)
    if (account !== null) {
      // Recorded so a settings page can show an account nobody uses any more. Best-effort: a write
      // here must never make a valid request fail.
      try {
        this.secrets.markAccountUsed(account.id)
      }
      catch {
        // A read-only secrets file (a mounted config, a full disk) is not a reason to refuse.
      }
      return { authenticated: true, method: 'token', session: null, account }
    }
    return ANONYMOUS
  }

  /**
   * The account a `Bearer <id>:<secret>` header names, or `null`.
   *
   * The **id travels in the credential**, exactly as a username travels with a password: the panel
   * cannot be asked "which account is this secret for" without comparing it against every stored hash,
   * which is both slower and a timing signal. Splitting on the first `:` keeps a secret containing one
   * intact, and a missing `:` is refused rather than guessed — a legacy single-value token is not an
   * account and must not silently become one.
   */
  accountFromBearer(value: string): AccountRecord | null {
    const separator = value.indexOf(':')
    if (separator <= 0 || separator === value.length - 1)
      return null
    const id = value.slice(0, separator)
    const secret = value.slice(separator + 1)
    if (accountIdProblem(id) !== null)
      return null
    if (!this.secrets.verifyAccountSecret(id, secret))
      return null
    const account = this.secrets.account(id)
    return account !== null && account.enabled ? account : null
  }

  /** `credential` is which kind answered; the login route passes `session`, the route above derives it. */
  sessionView(authenticated: boolean, credential?: SessionView['credential']): SessionView {
    return {
      authenticated,
      authRequired: this.isRequired(),
      passwordSet: this.secrets.passwordSet,
      apiTokenSet: this.secrets.apiTokenSet,
      usingDefaultPassword: this.secrets.usingDefaultPassword,
      // The first-run password is shown on the machine that started the panel, never over the API,
      // so the field is **absent** rather than a `null` that promised a value that cannot arrive.
      sessionTtlMs: this.getConfig().sessionTtlMs,
      ...(credential === undefined ? {} : { credential }),
    }
  }

  tokenFromCookie(cookieHeader: string | null | undefined): string | null {
    return parseCookies(cookieHeader)[SESSION_COOKIE] ?? null
  }

  /**
   * Sliding expiry: an active panel stays logged in, an idle one does not. `slide: false` checks
   * without counting as a visit — an open event stream re-checks its caller, and must not keep an
   * idle session alive past the cookie the browser holds.
   */
  validate(token: string | null, options: { slide?: boolean } = {}): SessionRecord | null {
    if (!token)
      return null
    const session = this.sessions.get(token)
    if (!session)
      return null
    // The password changed since this session was issued — by the API, or by `set-password` in
    // another process writing the same file. Either way the credential it represents is gone.
    if (session.passwordRevision !== this.secrets.passwordUpdatedAt) {
      this.sessions.delete(token)
      return null
    }

    const now = Date.now()
    if (session.expiresAt <= now) {
      this.sessions.delete(token)
      return null
    }

    if (options.slide !== false) {
      session.lastSeenAt = now
      session.expiresAt = now + this.getConfig().sessionTtlMs
    }
    return session
  }

  /**
   * Called whenever a credential may have stopped being valid (sign-out, password set, changed or
   * cleared), so a long-lived connection authorised at its start can re-check its caller at once
   * rather than outliving the credential. Returns the unsubscribe.
   */
  onCredentialsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Tells every listener; one that throws must not keep the others from hearing it. */
  notifyCredentialsChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      }
      catch {}
    }
  }

  /**
   * How far the session deadline may slide past the deadline the browser was last told about before
   * the cookie is re-sent.
   *
   * The cookie is only re-issued when it has fallen this far behind, so a panel in constant use keeps
   * a live cookie without a `Set-Cookie` on every request — an SSE stream opens one connection and
   * holds it. Quarter of the idle window, floored at 30 s so a short TTL still refreshes usefully and
   * capped at an hour so a week-long one costs at most one header an hour.
   */
  private cookieRefreshThresholdMs(): number {
    const ttl = this.getConfig().sessionTtlMs
    return Math.max(30_000, Math.min(ttl / 4, 3_600_000))
  }

  /**
   * The `Max-Age` to send, when this request should slide the *cookie* forward too; otherwise null.
   *
   * `validate()` slides `expiresAt` on every request, which makes the lifetime an idle timeout — but
   * a browser drops a cookie at the `Max-Age` it was issued with, and nothing was re-issuing it. So
   * the server kept a session a week after login while the browser had thrown its half away: a panel
   * used every ten seconds was still signed out at the configured lifetime, which is the opposite of
   * what the login page promises. Marking the deadline actually sent makes the two agree, and only
   * when it has moved enough to matter.
   */
  refreshCookie(session: SessionRecord): number | null {
    const now = Date.now()
    if (session.expiresAt - session.cookieExpiresAt < this.cookieRefreshThresholdMs())
      return null
    session.cookieExpiresAt = session.expiresAt
    return Math.max(0, session.expiresAt - now)
  }

  /** The cookie policy the guard and the login route must agree on. */
  get cookieSecureMode(): AuthConfig['cookieSecure'] {
    return this.getConfig().cookieSecure
  }

  /** Every account, metadata only — what a settings page lists. */
  listAccounts(): AccountView[] {
    return this.secrets.listAccounts()
  }

  /** Applies a settings-page edit, ending the account's sessions if it was disabled. */
  updateAccount(id: string, patch: { label?: string, scopes?: ApiTokenScope[], workspaces?: string[] | null, enabled?: boolean }): AccountView | null {
    const updated = this.secrets.updateAccount(id, patch)
    if (updated === null)
      return null
    // A disabled account must not keep working through a cookie it already holds.
    if (updated.enabled !== true) {
      for (const [token, session] of [...this.sessions]) {
        if (session.accountId === id)
          this.sessions.delete(token)
      }
    }
    this.notifyCredentialsChanged()
    return this.secrets.listAccounts().find(entry => entry.id === id) ?? null
  }

  /** Whether this id + secret pair is the signed-in account's own, for the change-secret flow. */
  verifyAccountSecret(id: string, secret: string): boolean {
    return this.secrets.verifyAccountSecret(id, secret)
  }

  /**
   * Signs an account in with its id **and** secret.
   *
   * Two halves, deliberately: an id alone is not a guessable secret and a secret alone is not an
   * account, so a stolen file of ids is worthless and a blind guess has to get both right. The
   * attempt budget is keyed on the address as before, and an unknown id costs the same path as a
   * wrong secret — the caller cannot learn which accounts exist from the timing or the answer.
   */
  login(id: string, secret: string, ip: string | null): LoginOutcome {
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

    // The panel-wide budget: once spent, nobody is checked until the window closes — a correct
    // guess included, or the cap would bound nothing.
    if (now - this.globalFailures.windowStart >= this.limits.globalFailureWindowMs)
      this.globalFailures = { count: 0, windowStart: now }
    if (this.globalFailures.count >= this.limits.globalFailureBudget) {
      const retryAfterMs = this.globalFailures.windowStart + this.limits.globalFailureWindowMs - now
      return {
        ok: false,
        status: 429,
        error: `too many failed sign-ins on this panel, retry in ${Math.ceil(retryAfterMs / 1000)}s (or run \`home-hosted account reset\` on the machine)`,
        retryAfterMs,
      }
    }

    if (!this.secrets.anyAccountEnabled) {
      return { ok: false, status: 409, error: 'no account can sign in yet' }
    }

    /**
     * A wrong id and a wrong secret take the same path: the account lookup returns `null` and
     * `verifyAccountSecret` refuses, and both land here. The answer never says which half was wrong,
     * because that would confirm an id exists.
     */
    const account = this.secrets.account(id)
    if (account === null || !this.secrets.verifyAccountSecret(id, secret)) {
      this.globalFailures.count += 1
      const failures = (attempt?.failures ?? 0) + 1
      if (failures >= config.maxLoginAttempts) {
        const blocks = (attempt?.blocks ?? 0) + 1
        const blockedUntil = Date.now() + Math.min(config.lockoutMs * 2 ** (blocks - 1), MAX_LOCKOUT_MS)
        this.recordAttempt(key, { failures: 0, blockedUntil, blocks, lastAttemptAt: Date.now() })
      }
      else {
        this.recordAttempt(key, { failures, blockedUntil: 0, blocks: attempt?.blocks ?? 0, lastAttemptAt: Date.now() })
      }
      return { ok: false, status: 401, error: 'invalid account id or secret' }
    }

    this.attempts.delete(key)
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (oldest)
        this.sessions.delete(oldest.token)
    }

    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = now + config.sessionTtlMs
    this.sessions.set(token, {
      token,
      accountId: account.id,
      passwordRevision: this.secrets.passwordUpdatedAt,
      expiresAt,
      // The login response sets this same deadline, so the browser is already in step.
      cookieExpiresAt: expiresAt,
      lastSeenAt: now,
      ip,
    })

    return { ok: true, status: 200, token, maxAgeMs: config.sessionTtlMs }
  }

  /**
   * Bounded on insert, not only in the minute sweep: with a client-chosen key a burst could grow the
   * map without limit between sweeps. Re-inserting keeps the map in last-attempt order, so the first
   * key is always the stalest.
   */
  private recordAttempt(key: string, record: AttemptRecord): void {
    this.attempts.delete(key)
    while (this.attempts.size >= this.limits.maxAttemptRecords) {
      const oldest = this.attempts.keys().next()
      if (oldest.done === true)
        break
      this.attempts.delete(oldest.value)
    }
    this.attempts.set(key, record)
  }

  /** How many per-address records are held, for tests and diagnostics. */
  attemptRecords(): number {
    return this.attempts.size
  }

  logout(token: string | null): void {
    if (token && this.sessions.delete(token))
      this.notifyCredentialsChanged()
  }

  logoutAll(): void {
    this.sessions.clear()
    this.notifyCredentialsChanged()
  }

  /**
   * Changing an account's secret must not leave that account's older sessions valid.
   *
   * The session that made the change is kept — being signed out of the page you just used is not a
   * security requirement, and it makes a successful change look like a failure — but every *other*
   * session of **that account** ends, and other accounts' sessions are untouched: they are other
   * people, and rotating your own secret is not a reason to sign them out.
   */
  setAccountSecret(id: string, secret: string, options: { keepToken?: string | null } = {}): void {
    this.secrets.setAccountSecret(id, secret)
    const keep = options.keepToken ?? null
    for (const [token, session] of [...this.sessions]) {
      if (session.accountId === id && token !== keep)
        this.sessions.delete(token)
    }
    const session = keep === null ? undefined : this.sessions.get(keep)
    if (session !== undefined)
      session.passwordRevision = this.secrets.passwordUpdatedAt
    this.notifyCredentialsChanged()
  }

  /** Revoking an account ends its sessions too: a valid cookie must not outlive the credential. */
  revokeAccount(id: string): boolean {
    if (!this.secrets.revokeAccount(id))
      return false
    for (const [token, session] of [...this.sessions]) {
      if (session.accountId === id)
        this.sessions.delete(token)
    }
    this.notifyCredentialsChanged()
    return true
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

  /**
   * Creates the boot-time `default` account only when nothing can sign in yet.
   *
   * The first-run secret is generated by the panel and printed once on the machine that started it,
   * so a fresh home is never a locked door and never ships a guessable default.
   */
  ensureDefaultAccount(secret: string): boolean {
    if (this.secrets.anyAccountEnabled)
      return false
    this.secrets.createAccount({ id: 'default', label: 'default', scopes: [...API_TOKEN_SCOPES], secret, enabled: true, isDefault: true, keepInitial: true })
    this.logoutAll()
    return true
  }

  dispose(): void {
    clearInterval(this.timer)
    this.sessions.clear()
    this.listeners.clear()
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

    if (this.attempts.size > this.limits.maxAttemptRecords) {
      const oldest = [...this.attempts.entries()]
        .sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt)
        .slice(0, this.attempts.size - this.limits.maxAttemptRecords)
      for (const [key] of oldest) this.attempts.delete(key)
    }
  }
}
