import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import process from 'node:process'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { logger } from '#src/helpers/logger'
import { errorMessage } from '#src/shared/error-message'
import { EXPOSED_PASSWORD_MIN_LENGTH, passwordLength } from '#src/shared/password-policy'
import { isRecord } from '#src/shared/shape'

/** Node's scrypt defaults, pinned so a hash stays verifiable across versions. */
const COST = { N: 16384, r: 8, p: 1 } as const
const KEYLEN = 64
const SALT_BYTES = 16

export interface PasswordRecord {
  algo: 'scrypt'
  salt: string
  hash: string
  keylen: number
  cost: { N: number, r: number, p: number }
  updatedAt: number
  /** Set for the boot-time default, so the UI can say so and exposure stays blocked. */
  isDefault?: boolean
  /**
   * The generated first-run password, kept in this 0600 file only while it is still in use so
   * `up`/`status` can show it on the machine. Never sent over the API; gone with the first change.
   */
  initial?: string
  /**
   * The password was shorter than `EXPOSED_PASSWORD_MIN_LENGTH` when it was hashed, so exposure
   * beyond loopback stays blocked. Recorded at write time because a hash cannot be measured later;
   * a record without it (written before the flag existed) reads as long enough.
   */
  short?: boolean
}

/**
 * An API token for scripts and agents. Tokens are high-entropy randoms, so a
 * plain SHA-256 is the right hash — scrypt would only make every request pay
 * for a slow KDF it does not need. `hint` is the readable head, kept so a human
 * can tell two tokens apart without the file ever holding the whole secret.
 */
export interface ApiTokenRecord {
  algo: 'sha256'
  hash: string
  hint: string
  updatedAt: number
}

/**
 * What a token may do. Declared once, because the spec, the enforcement and the docs must agree.
 *
 * - `read` — every `GET`;
 * - `lifecycle` — start, stop, restart, free-port, clear-logs;
 * - `config` — server, workspace and settings writes, and backups;
 * - `admin` — everything, including tokens, the password, UI install and restoring secrets.
 *
 * They are cumulative (`admin` implies the rest), and `workspaces` narrows a token to some
 * workspaces. A panel-wide write needs no workspace limit, because there is no workspace to narrow.
 */
export const API_TOKEN_SCOPES = ['read', 'lifecycle', 'config', 'admin'] as const
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number]

/**
 * One named token. `id` is a stable, human-typable handle the API and the UI use to revoke it; the
 * **hash** is the only thing stored that could be used to authenticate, and it never leaves the file.
 */
export interface NamedApiTokenRecord extends ApiTokenRecord {
  id: string
  name: string
  scopes: ApiTokenScope[]
  /** Absent means every workspace. An empty array would mean none, which is not a useful state. */
  workspaces?: string[]
  /** Set the first time it authenticates a request, so a stale token is visible. */
  lastUsedAt?: number
}

/**
 * A token as a listing shows it: metadata only, never the hash.
 *
 * `createdAt` is the record's `updatedAt` — the moment it was minted, since nothing updates a token
 * after that. Renamed for the listing because "updated" reads as if it changes.
 */
export interface ApiTokenView {
  id: string
  name: string
  scopes: ApiTokenScope[]
  workspaces?: string[]
  createdAt: number
  lastUsedAt?: number
}

/** One account's provider credentials, with the provider they were entered for. */
export interface DdnsCredentialRecord {
  provider: string
  values: Record<string, string>
}

/** An account's credentials as they sit on disk: sealed, never plaintext. */
interface SealedDdnsRecord {
  algo: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

/** Read from a file written before sealing; re-sealed by the next write. */
interface PlainDdnsRecord {
  plain: true
  provider: string
  values: Record<string, string>
}

type StoredDdnsRecord = SealedDdnsRecord | PlainDdnsRecord

/** One derivation per process: the secret is combined with this per-file salt. */
interface DdnsKdfMeta {
  algo: 'scrypt'
  cost: ScryptCost
  salt: string
}

/**
 * Which halves of the file a store owns. Global secrets (the password hash and
 * the API token) live above the workspaces, in `.hh/.control-secrets.json`;
 * workspace secrets (the Telegram bot token and DDNS credentials) live in that
 * workspace's own `.secrets.json`. `all` is the shape the pre-workspace file had
 * and is still what a backup archive may carry.
 */
export type SecretsScope = 'all' | 'global' | 'workspace'

interface SecretsFile {
  password: PasswordRecord | null
  apiToken: ApiTokenRecord | null
  /**
   * The named tokens. `apiToken` is the pre-0.14 single token, kept only so a file written by an older
   * release still authenticates: it is migrated into this list on the first write and never written
   * again.
   */
  apiTokens: NamedApiTokenRecord[]
  /**
   * Bot tokens by destination id. A map, not a singleton: a workspace may point at more than one
   * Telegram chat, and each destination carries its own bot.
   */
  telegram: Record<string, string>
  /** Per-DDNS-account credentials, keyed by the account id in the config. */
  ddns: Record<string, StoredDdnsRecord>
  /** How the DDNS key is derived; absent until the first sealed write. */
  ddnsKdf: DdnsKdfMeta | null
  /**
   * Per-server secret environment values: `{ [serverId]: { [NAME]: value } }`.
   *
   * A **workspace** file only. The names are declared on the entry in `servers.config.json`; only the
   * values live here, because a config is copied into backups, printed by `status` and served over
   * the API — a value in it is a value published. Plaintext in a 0600 file, like the Telegram bot
   * tokens beside it: the file's permissions are the protection, and sealing one field here would
   * make the store's `save` do two different things.
   */
  serverEnv: Record<string, Record<string, string>>
  /** Top-level keys this release does not know, carried through a write so a newer release keeps them. */
  extra?: Record<string, unknown>
}

/** Owned by this release, plus `version`: retired, and dropped on the next write rather than carried. */
const KNOWN_SECRET_KEYS = new Set(['password', 'apiToken', 'apiTokens', 'telegram', 'ddns', 'ddnsKdf', 'serverEnv', 'version'])

function unknownTopLevel(parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return {}
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !KNOWN_SECRET_KEYS.has(key)))
}

/**
 * The id the config migration gives a pre-list Telegram destination, so its stored `{ botToken }`
 * still finds an owner after the upgrade.
 */
export const LEGACY_TELEGRAM_ID = 'telegram'

/** So a first run is sealed rather than plaintext; set `HHOSTED_DDNS_SECRET` for real protection. */
export const DEFAULT_DDNS_SECRET = 'hh'
const DDNS_KEYLEN = 32
const DDNS_IV_BYTES = 12
const DDNS_AAD_PREFIX = 'hh-ddns-v1:'
const DDNS_SEALED_ALGO = 'aes-256-gcm'

export interface ScryptCost { N: number, r: number, p: number }

export function deriveKey(password: string, salt: Buffer, cost: ScryptCost, keylen: number): Buffer {
  return crypto.scryptSync(password.normalize('NFKC'), salt, keylen, { ...cost })
}

export function hashPassword(password: string, options: { now?: number, isDefault?: boolean, initial?: boolean } = {}): PasswordRecord {
  const salt = crypto.randomBytes(SALT_BYTES)
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: deriveKey(password, salt, COST, KEYLEN).toString('base64'),
    keylen: KEYLEN,
    cost: { ...COST },
    updatedAt: options.now ?? Date.now(),
    ...(options.isDefault === true ? { isDefault: true } : {}),
    ...(options.isDefault === true && options.initial === true ? { initial: password } : {}),
    ...(passwordLength(password) < EXPOSED_PASSWORD_MIN_LENGTH ? { short: true } : {}),
  }
}

/** The pre-0.12 boot password every install shared. Still recognised, never created. */
export const LEGACY_DEFAULT_PASSWORD = 'hh'

/** A random first-run password: 12 characters from an unambiguous alphabet, ~60 bits. */
export function generateInitialPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(12)
  const chars = [...bytes].map(byte => alphabet[byte % alphabet.length])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map(group => group.join('')).join('-')
}

export function verifyPassword(password: string, record: PasswordRecord): boolean {
  const expected = Buffer.from(record.hash, 'base64')
  let actual: Buffer
  try {
    actual = deriveKey(password, Buffer.from(record.salt, 'base64'), record.cost, record.keylen)
  }
  catch {
    return false
  }
  if (actual.length !== expected.length)
    return false
  return crypto.timingSafeEqual(actual, expected)
}

/** Visible head of a generated token, so a token is recognisable on sight. */
export const API_TOKEN_PREFIX = 'hh_'
const API_TOKEN_BYTES = 32
const API_TOKEN_HINT_CHARS = 8

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(API_TOKEN_BYTES).toString('base64url')}`
}

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64')
}

export function verifyApiToken(token: string, record: ApiTokenRecord): boolean {
  if (token.length === 0)
    return false
  const expected = Buffer.from(record.hash, 'base64')
  const actual = Buffer.from(hashApiToken(token), 'base64')
  // A hand-edited or truncated secrets file must not make every request throw.
  if (actual.length !== expected.length)
    return false
  return crypto.timingSafeEqual(actual, expected)
}

export function apiTokenRecord(token: string, now = Date.now()): ApiTokenRecord {
  return {
    algo: 'sha256',
    hash: hashApiToken(token),
    hint: token.slice(0, API_TOKEN_HINT_CHARS),
    updatedAt: now,
  }
}

/** A field map: strings only, empty values dropped; anything else reads as absent. */
function readDdnsValues(value: unknown): Record<string, string> {
  if (!isRecord(value))
    return {}
  const out: Record<string, string> = {}
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' && field.length > 0)
      out[key] = field
  }
  return out
}

function isSealedDdns(value: unknown): value is SealedDdnsRecord {
  return isRecord(value)
    && value.algo === DDNS_SEALED_ALGO
    && typeof value.iv === 'string'
    && typeof value.tag === 'string'
    && typeof value.data === 'string'
}

function isPlainDdns(value: StoredDdnsRecord): value is PlainDdnsRecord {
  return 'plain' in value
}

/**
 * The bot tokens by destination id.
 *
 * Two shapes read: the map this release writes, and the single `{ botToken }` written before a
 * workspace could have more than one Telegram destination. The old one arrives under the id the
 * config migration gave the destination it came from, so an upgrade keeps a working Telegram.
 */
function readTelegramTokens(value: unknown): Record<string, string> {
  if (!isRecord(value))
    return {}
  // The legacy singleton.
  if (typeof value.botToken === 'string')
    return value.botToken.trim().length > 0 ? { [LEGACY_TELEGRAM_ID]: value.botToken.trim() } : {}
  const tokens: Record<string, string> = {}
  for (const [id, token] of Object.entries(value)) {
    if (typeof token === 'string' && token.trim().length > 0)
      tokens[id] = token.trim()
  }
  return tokens
}

/**
 * Sealed on disk, or `{ provider, values }` waiting for the sealing write. A bare
 * field map — written before the provider was recorded — no longer reads, because
 * there is nothing to say which provider those fields belong to.
 */
function readStoredDdns(value: unknown): Record<string, StoredDdnsRecord> {
  if (!isRecord(value))
    return {}
  const out: Record<string, StoredDdnsRecord> = {}
  for (const [accountId, entry] of Object.entries(value)) {
    if (isSealedDdns(entry)) {
      out[accountId] = entry
      continue
    }
    if (!isRecord(entry) || typeof entry.provider !== 'string' || entry.provider.length === 0)
      continue
    const values = readDdnsValues(entry.values)
    if (Object.keys(values).length === 0)
      continue
    out[accountId] = { plain: true, provider: entry.provider, values }
  }
  return out
}

/**
 * A hand-edited `serverEnv` block, read tolerantly.
 *
 * A file this release wrote always matches; one a person edited (or a newer release wrote) may hold a
 * non-string value or a nested shape. Anything that is not `{ serverId: { NAME: string } }` is dropped
 * rather than taken as a reason to refuse the whole file — the same rule the other unknown shapes
 * follow, and the reason a typo in one entry cannot lock a person out of their panel.
 */
/**
 * A hand-edited `apiTokens` list, read tolerantly — and the **legacy single token migrated in**.
 *
 * A file written by an older release has `apiToken` and no list. That token becomes one named
 * `default` with `admin` and no workspace limit: it *was* full admin, so anything narrower would
 * silently remove access an upgrade never announced. The migration happens on read, and the next
 * write persists the list and drops the legacy field — which is why a revoke cannot resurrect it.
 */
function readNamedTokens(value: unknown): NamedApiTokenRecord[] {
  if (!Array.isArray(value))
    return []
  const tokens: NamedApiTokenRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.hash !== 'string' || typeof entry.id !== 'string' || typeof entry.name !== 'string')
      continue
    if (seen.has(entry.id))
      continue
    seen.add(entry.id)
    const scopes = Array.isArray(entry.scopes)
      ? entry.scopes.filter((scope): scope is ApiTokenScope => typeof scope === 'string' && (API_TOKEN_SCOPES as readonly string[]).includes(scope))
      : []
    const workspaces = Array.isArray(entry.workspaces)
      ? entry.workspaces.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined
    tokens.push({
      algo: 'sha256',
      id: entry.id,
      name: entry.name,
      hash: entry.hash,
      hint: typeof entry.hint === 'string' ? entry.hint : '',
      // A record with no scopes is a hand-edit that would authenticate for nothing; `read` is the
      // least it can mean, and an empty list is never what someone intended.
      scopes: scopes.length === 0 ? ['read'] : scopes,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
      ...(workspaces === undefined || workspaces.length === 0 ? {} : { workspaces }),
      ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
    })
  }
  return tokens
}

function readServerEnv(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value))
    return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [serverId, entry] of Object.entries(value)) {
    if (!isRecord(entry))
      continue
    const names: Record<string, string> = {}
    for (const [name, raw] of Object.entries(entry)) {
      if (typeof raw === 'string')
        names[name] = raw
    }
    if (Object.keys(names).length > 0)
      out[serverId] = names
  }
  return out
}

function readDdnsKdf(value: unknown): DdnsKdfMeta | null {
  if (!isRecord(value) || value.algo !== 'scrypt' || typeof value.salt !== 'string')
    return null
  const cost = isRecord(value.cost) ? value.cost : {}
  const N = Number(cost.N)
  const r = Number(cost.r)
  const p = Number(cost.p)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1)
    return null
  return { algo: 'scrypt', cost: { N, r, p }, salt: value.salt }
}

function newDdnsKdf(): DdnsKdfMeta {
  return { algo: 'scrypt', cost: { ...COST }, salt: crypto.randomBytes(SALT_BYTES).toString('base64') }
}

/** The account id is the AAD, so a sealed entry cannot be moved to another account. */
function ddnsAad(accountId: string): Buffer {
  return Buffer.from(`${DDNS_AAD_PREFIX}${accountId}`, 'utf8')
}

function sealDdns(accountId: string, record: DdnsCredentialRecord, key: Buffer): SealedDdnsRecord {
  const iv = crypto.randomBytes(DDNS_IV_BYTES)
  const cipher = crypto.createCipheriv(DDNS_SEALED_ALGO, key, iv)
  cipher.setAAD(ddnsAad(accountId))
  const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
  return {
    algo: DDNS_SEALED_ALGO,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** Null when the tag does not verify: a different secret, or a file somebody edited. */
function openDdns(accountId: string, sealed: SealedDdnsRecord, key: Buffer): DdnsCredentialRecord | null {
  try {
    const decipher = crypto.createDecipheriv(DDNS_SEALED_ALGO, key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(ddnsAad(accountId))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plain) as Partial<DdnsCredentialRecord>
    if (typeof parsed?.provider !== 'string')
      return null
    const values = readDdnsValues(parsed.values)
    return Object.keys(values).length === 0 ? null : { provider: parsed.provider, values }
  }
  catch {
    return null
  }
}

/**
 * The password hash and the API token are secrets, so they live outside
 * `servers.config.json` (which is tracked) in a 0600 file that is git-ignored.
 *
 * DDNS provider credentials are the one thing here the panel has to replay to a
 * third party, so they are sealed with AES-256-GCM under `HHOSTED_DDNS_SECRET`.
 * Everything else is a one-way hash and needs no key.
 */
export class SecretsStore {
  private cache: SecretsFile | null = null
  private cacheKey = ''
  private error: string | null = null
  private ddnsKeyCache: { salt: string, key: Buffer } | null = null
  private readonly warnedAccounts = new Set<string>()
  private warnedDefaultSecret = false
  private readonly ddnsSecret: string

  constructor(private readonly file: string, ddnsSecret?: string, private readonly scope: SecretsScope = 'all') {
    const candidate = (ddnsSecret ?? process.env.HHOSTED_DDNS_SECRET ?? '').trim()
    this.ddnsSecret = candidate.length > 0 ? candidate : DEFAULT_DDNS_SECRET
  }

  /**
   * Whether the DDNS credentials are sealed under the built-in key.
   *
   * Sealing is what stops a leaked *file* — a backup, a committed state directory — from handing over
   * the DNS credentials. Under the default the key is the literal `hh`, so anyone holding the file can
   * open it. The docs say so; this is the same fact for code that wants to say so at runtime.
   */
  get usingDefaultDdnsSecret(): boolean {
    return this.ddnsSecret === DEFAULT_DDNS_SECRET
  }

  get path(): string {
    return this.file
  }

  /**
   * Re-reads whenever the file changes on disk, so a password set by
   * `home-hosted set-password` (or another process) takes effect without
   * restarting `up`.
   */
  load(): SecretsFile {
    const key = this.statKey()
    if (this.cache !== null && key === this.cacheKey)
      return this.cache
    this.cache = this.read()
    this.cacheKey = key
    return this.cache
  }

  private statKey(): string {
    try {
      const stats = fs.statSync(this.file)
      return `${stats.mtimeMs}:${stats.size}`
    }
    catch {
      return 'missing'
    }
  }

  get password(): PasswordRecord | null {
    return this.load().password
  }

  get passwordUpdatedAt(): number | null {
    return this.password?.updatedAt ?? null
  }

  get passwordSet(): boolean {
    return this.password !== null
  }

  get usingDefaultPassword(): boolean {
    return this.password?.isDefault === true
  }

  /** The stored password is too short to expose the panel behind; see `PasswordRecord.short`. */
  get passwordTooShort(): boolean {
    return this.password?.short === true
  }

  /**
   * The first configured token, whichever release wrote it.
   *
   * It answered about the pre-0.14 singleton when that was the only token there was. With named
   * tokens, "the token" means the first of them — and the legacy field is migrated into that list, so
   * this never answers `null` for a home that has one. A caller that needs a *specific* token asks
   * `findApiToken(value)` or reads `apiTokens`.
   */
  get apiToken(): ApiTokenRecord | null {
    const contents = this.load()
    if (contents.apiToken !== null)
      return contents.apiToken
    return this.apiTokens[0] ?? null
  }

  /** Whether **any** token is configured — the legacy field or one of the named ones. */
  get apiTokenSet(): boolean {
    return this.apiToken !== null || this.apiTokens.length > 0
  }

  /** The first token's readable head, or null when none is set. */
  get apiTokenHint(): string | null {
    return this.apiToken?.hint ?? this.apiTokens[0]?.hint ?? null
  }

  /** The bot token for one destination, or null when it has none. */
  telegramToken(id: string): string | null {
    const token = this.load().telegram[id] ?? ''
    return token.length > 0 ? token : null
  }

  telegramTokenSet(id: string): boolean {
    return this.telegramToken(id) !== null
  }

  /** Every destination id a token is stored for — including one the config no longer declares. */
  get telegramTokenIds(): string[] {
    return Object.keys(this.load().telegram).sort()
  }

  /**
   * The first-run password while it is still the one in use, for a person on this machine.
   * A home from before 0.12 still on the shared default reports that one.
   */
  get initialPassword(): string | null {
    const record = this.password
    if (record?.isDefault !== true)
      return null
    if (typeof record.initial === 'string' && record.initial.length > 0)
      return record.initial
    return verifyPassword(LEGACY_DEFAULT_PASSWORD, record) ? LEGACY_DEFAULT_PASSWORD : null
  }

  setPassword(password: string, options: { isDefault?: boolean, initial?: boolean } = {}): PasswordRecord {
    const record = hashPassword(password, options)
    this.save({ ...this.load(), password: record })
    return record
  }

  /** Creates the first-run password only when none exists yet. */
  ensureDefaultPassword(password: string): PasswordRecord | null {
    if (this.passwordSet)
      return null
    return this.setPassword(password, { isDefault: true, initial: true })
  }

  clearPassword(): void {
    this.save({ ...this.load(), password: null })
  }

  /**
   * The named tokens, with the pre-0.14 single token migrated in.
   *
   * The migration is here rather than in a config migration because this is a **secrets** file, and
   * it is the only place that can read it: the old token becomes `default`/`admin`, so an upgrade
   * removes no access. It runs on every read and is persisted by the next write, which drops
   * `apiToken` — so a revoke cannot resurrect it.
   */
  get apiTokens(): NamedApiTokenRecord[] {
    const contents = this.load()
    if (contents.apiToken === null)
      return contents.apiTokens
    if (contents.apiTokens.some(entry => entry.name === 'default'))
      return contents.apiTokens
    return [{
      ...contents.apiToken,
      id: 'default',
      name: 'default',
      scopes: ['admin'],
    }, ...contents.apiTokens]
  }

  /** Metadata for the list a settings page shows: ids, names, scopes, workspaces, when last used. */
  listApiTokens(): ApiTokenView[] {
    return this.apiTokens.map(({ hash: _hash, algo: _algo, updatedAt, hint: _hint, ...rest }) => ({ ...rest, createdAt: updatedAt }))
  }

  /**
   * The token a bearer value names, or `null`. Constant-time against every stored hash.
   *
   * Every candidate is compared, not just the first: returning early on a mismatch of the *earlier*
   * entries would make the number of comparisons a function of which token was presented, which is
   * the timing signal `timingSafeEqual` exists to remove.
   */
  findApiToken(token: string): NamedApiTokenRecord | null {
    if (token.length === 0)
      return null
    let found: NamedApiTokenRecord | null = null
    for (const candidate of this.apiTokens) {
      if (verifyApiToken(token, candidate))
        found = candidate
    }
    return found
  }

  /**
   * Mints one, returning the token **once**.
   *
   * `id` is derived from the name so it is typable in a `DELETE /api/auth/tokens/:id`, and a
   * duplicate name is refused: two tokens called `monitor` are indistinguishable in a listing, which
   * is the whole reason tokens are named.
   */
  createApiToken(input: { name: string, scopes: ApiTokenScope[], workspaces?: string[] }, now = Date.now()): { token: string, record: NamedApiTokenRecord } {
    const name = input.name.trim()
    if (name.length === 0)
      throw new Error('a token needs a name')
    if (input.scopes.length === 0)
      throw new Error('a token needs at least one scope')
    const existing = this.apiTokens
    if (existing.some(entry => entry.name === name))
      throw new Error(`a token named "${name}" already exists`)

    const token = generateApiToken()
    const base = apiTokenRecord(token, now)
    // A slug, then a suffix if that collides — `id` must be unique, `name` is what a person reads.
    const baseId = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'token'
    let id = baseId
    let index = 2
    while (existing.some(entry => entry.id === id))
      id = `${baseId}-${index++}`

    const record: NamedApiTokenRecord = {
      ...base,
      id,
      name,
      scopes: [...new Set(input.scopes)],
      ...(input.workspaces === undefined || input.workspaces.length === 0 ? {} : { workspaces: [...new Set(input.workspaces)] }),
    }
    // Persisted, and the legacy field cleared in the same write: the migration is now on disk.
    this.save({ ...this.load(), apiToken: null, apiTokens: [...existing, record] })
    return { token, record }
  }

  /** `true` when it removed one, `false` when no such id — a 404 is the caller's to answer. */
  revokeApiToken(id: string): boolean {
    const existing = this.apiTokens
    const next = existing.filter(entry => entry.id !== id)
    if (next.length === existing.length)
      return false
    this.save({ ...this.load(), apiToken: null, apiTokens: next })
    return true
  }

  /** Records a successful use, so a settings page can show a token nobody uses any more. */
  markApiTokenUsed(id: string, now = Date.now()): void {
    const existing = this.apiTokens
    const index = existing.findIndex(entry => entry.id === id)
    if (index === -1)
      return
    const next = [...existing]
    next[index] = { ...next[index]!, lastUsedAt: now }
    this.save({ ...this.load(), apiToken: null, apiTokens: next })
  }

  /** The pre-0.14 single token, still what `set-token`/`set-token --clear` act on. */
  setApiToken(token: string): ApiTokenRecord {
    const record = apiTokenRecord(token)
    // The old route rotates `default`: it is the token an upgraded home already had, and the one a
    // person running `set-token` means.
    const existing = this.apiTokens
    const index = existing.findIndex(entry => entry.id === 'default')
    const named: NamedApiTokenRecord = index === -1
      ? { ...record, id: 'default', name: 'default', scopes: ['admin'] }
      : { ...record, id: 'default', name: existing[index]!.name, scopes: existing[index]!.scopes, ...(existing[index]!.workspaces === undefined ? {} : { workspaces: existing[index]!.workspaces }) }
    const next = index === -1 ? [...existing, named] : existing.map((entry, at) => (at === index ? named : entry))
    this.save({ ...this.load(), apiToken: null, apiTokens: next })
    return record
  }

  clearApiToken(): void {
    this.save({ ...this.load(), apiToken: null, apiTokens: this.apiTokens.filter(entry => entry.id !== 'default') })
  }

  setTelegramToken(id: string, token: string | null): void {
    const trimmed = token?.trim() ?? ''
    const current = { ...this.load().telegram }
    if (trimmed.length > 0)
      current[id] = trimmed
    else
      delete current[id]
    this.save({ ...this.load(), telegram: current })
  }

  /** Drops every token whose destination is gone, so a deleted target leaves nothing behind. */
  forgetTelegramTokens(keep: readonly string[]): void {
    const allowed = new Set(keep)
    const current = this.load().telegram
    const next = Object.fromEntries(Object.entries(current).filter(([id]) => allowed.has(id)))
    if (Object.keys(next).length !== Object.keys(current).length)
      this.save({ ...this.load(), telegram: next })
  }

  /** Ids that have something stored, whether or not a config still declares them. */
  get ddnsAccountIds(): string[] {
    return Object.keys(this.load().ddns)
  }

  /**
   * Null when nothing is stored, when the entry belongs to a different provider,
   * or when the secret cannot open it.
   */
  getDdnsCredentials(accountId: string, provider: string): DdnsCredentialRecord | null {
    const stored = this.load().ddns[accountId]
    if (stored === undefined)
      return null
    const record = this.openStored(accountId, stored)
    if (record === null)
      return null
    return record.provider === provider ? record : null
  }

  /**
   * One server's secret environment, as `{ NAME: value }` — for the spawn, never for a view.
   *
   * A caller that renders this is publishing secrets; the view exposes `serverEnvNames()` instead.
   */
  serverEnv(serverId: string): Record<string, string> {
    return { ...this.load().serverEnv[serverId] ?? {} }
  }

  /** The names that have a value, which is all a view may show. Sorted, so the UI is stable. */
  serverEnvNames(serverId: string): string[] {
    return Object.keys(this.load().serverEnv[serverId] ?? {}).sort()
  }

  /**
   * Replaces one server's secret environment.
   *
   * A **replacement**, not a merge: the API answers a `set` and an `unset` in one call, and a merge
   * would make removing a name possible only through a second request. Every name is validated here
   * as well as at the schema — this is the last point before a child's environment is built, and a
   * name no shell can read (`MY-VAR`) would be a variable the process cannot see.
   */
  setServerEnv(serverId: string, values: Record<string, string>): void {
    // `all` is the shape a pre-workspace file had and what a backup archive carries, so it owns every
    // field. `global` does not: the panel-wide secrets file must never gain a workspace's values.
    if (this.scope === 'global')
      throw new Error('a server\'s secret environment belongs to its workspace — a global secrets file cannot hold one')
    const clean: Record<string, string> = {}
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Z_]\w*$/i.test(name))
        throw new Error(`"${name}" is not an environment-variable name: a letter or underscore, then letters, digits or underscores`)
      clean[name] = value
    }
    const current = this.load()
    this.save({ ...current, serverEnv: { ...current.serverEnv, [serverId]: clean } })
  }

  /** Removes the named values from one server, leaving the rest. */
  unsetServerEnv(serverId: string, names: readonly string[]): void {
    const current = this.load()
    const existing = { ...current.serverEnv[serverId] ?? {} }
    for (const name of names)
      delete existing[name]
    const serverEnv = { ...current.serverEnv }
    if (Object.keys(existing).length === 0)
      delete serverEnv[serverId]
    else
      serverEnv[serverId] = existing
    this.save({ ...current, serverEnv })
  }

  /** Everything for one server, for a removal or a rename. */
  forgetServerEnv(serverId: string): void {
    const current = this.load()
    if (current.serverEnv[serverId] === undefined)
      return
    const serverEnv = { ...current.serverEnv }
    delete serverEnv[serverId]
    this.save({ ...current, serverEnv })
  }

  /** Moves a removed id's values onto another: a renamed entry keeps its secrets. */
  renameServerEnv(from: string, to: string): void {
    const current = this.load()
    const values = current.serverEnv[from]
    if (values === undefined)
      return
    const serverEnv = { ...current.serverEnv }
    delete serverEnv[from]
    serverEnv[to] = values
    this.save({ ...current, serverEnv })
  }

  /** An empty field is dropped, so clearing every field forgets the account. */
  setDdnsCredentials(accountId: string, provider: string, credentials: Record<string, string>): void {
    const current = this.load()
    const values = readDdnsValues(credentials)
    const ddns = { ...current.ddns }
    if (Object.keys(values).length === 0)
      delete ddns[accountId]
    else
      ddns[accountId] = { plain: true, provider, values }
    this.save({ ...current, ddns })
  }

  clearDdnsCredentials(accountId: string): void {
    const current = this.load()
    if (current.ddns[accountId] === undefined)
      return
    const ddns = { ...current.ddns }
    delete ddns[accountId]
    this.save({ ...current, ddns })
  }

  /** Keeps only the accounts a config still declares; returns how many were dropped. */
  pruneDdnsCredentials(keep: Iterable<string>): number {
    const wanted = new Set(keep)
    const current = this.load()
    const removed = Object.keys(current.ddns).filter(id => !wanted.has(id))
    if (removed.length === 0)
      return 0
    const ddns = { ...current.ddns }
    for (const id of removed) delete ddns[id]
    this.save({ ...current, ddns })
    return removed.length
  }

  private openStored(accountId: string, stored: StoredDdnsRecord): DdnsCredentialRecord | null {
    if (isPlainDdns(stored))
      return { provider: stored.provider, values: stored.values }

    const kdf = this.load().ddnsKdf
    if (kdf === null) {
      this.warnOnce(accountId, 'the file carries no key parameters')
      return null
    }
    const record = openDdns(accountId, stored, this.ddnsKey(kdf))
    if (record === null)
      this.warnOnce(accountId, `the entry could not be opened — is HHOSTED_DDNS_SECRET still the one it was sealed with?`)
    return record
  }

  /** One derivation per file salt, cached for the life of the process. */
  private ddnsKey(kdf: DdnsKdfMeta): Buffer {
    if (this.ddnsKeyCache?.salt === kdf.salt)
      return this.ddnsKeyCache.key
    const key = deriveKey(this.ddnsSecret, Buffer.from(kdf.salt, 'base64'), kdf.cost, DDNS_KEYLEN)
    this.ddnsKeyCache = { salt: kdf.salt, key }
    return key
  }

  private warnOnce(accountId: string, reason: string): void {
    if (this.warnedAccounts.has(accountId))
      return
    this.warnedAccounts.add(accountId)
    logger.warn(`ddns: cannot read the credentials for "${accountId}" — ${reason}`)
  }

  /**
   * A secrets file that exists but cannot be parsed, or null when it is fine (or absent).
   *
   * `read()` still returns the empty shape — a corrupt file must not authenticate anyone — but
   * "unreadable" and "absent" have to stay distinguishable: treated as absent, a truncated
   * `.control-secrets.json` reads as a fresh install, and `runControlPlane` then writes a
   * **default-password** file over it, destroying the password hash, the API token and every
   * Telegram and DDNS credential. Only the caller can refuse the boot, so this is its surface.
   */
  get configError(): string | null {
    this.load()
    return this.error
  }

  private read(): SecretsFile {
    this.error = null
    const empty: SecretsFile = { password: null, apiToken: null, apiTokens: [], telegram: {}, ddns: {}, ddnsKdf: null, serverEnv: {} }
    if (!fs.existsSync(this.file))
      return this.inScope(empty)
    let text: string
    try {
      text = readStateFile(this.file)
    }
    catch (error) {
      // Present but unreadable is not absent: permissions or a directory, say.
      this.error = `cannot read ${this.file}: ${errorMessage(error)}`
      return this.inScope(empty)
    }
    try {
      const parsed = JSON.parse(text) as Partial<SecretsFile>
      return this.inScope({
        password: parsed?.password ?? null,
        apiToken: parsed?.apiToken?.hash ? parsed.apiToken : null,
        apiTokens: readNamedTokens((parsed as { apiTokens?: unknown })?.apiTokens),
        telegram: readTelegramTokens(parsed?.telegram),
        ddns: readStoredDdns(parsed?.ddns),
        ddnsKdf: readDdnsKdf((parsed as { ddnsKdf?: unknown })?.ddnsKdf),
        serverEnv: readServerEnv(parsed?.serverEnv),
        extra: unknownTopLevel(parsed),
      })
    }
    catch (error) {
      this.error = `${this.file} is not readable JSON (${errorMessage(error)}) — it was left untouched`
      return this.inScope(empty)
    }
  }

  /** Everything a store does not own is neither read from nor written to its file. */
  private inScope(contents: SecretsFile): SecretsFile {
    if (this.scope === 'global')
      // A server's environment belongs to its workspace's file: a global store neither reads nor
      // writes it, so `set-password` cannot rewrite a workspace's secrets.
      return { ...contents, telegram: {}, ddns: {}, ddnsKdf: null, serverEnv: {} }
    if (this.scope === 'workspace')
      return { ...contents, password: null, apiToken: null, apiTokens: [] }
    return contents
  }

  private save(contents: SecretsFile): void {
    // Refuse to write over a file this store could not parse. Every writer reaches here
    // through `load()`, so without this the first `set-password`/`set-token` after a bad
    // edit replaces the user's password hash, API token and credentials with the one field
    // being set. `runControlPlane` refuses at boot; this is the same rule for every command
    // that does not boot one.
    if (this.configError !== null)
      throw new Error(`refusing to write ${this.file}: ${this.error}`)

    const sealed = this.sealStored(this.inScope(contents))
    const { extra, ...known } = sealed
    writeFileAtomic(this.file, `${JSON.stringify({ ...known, ...extra }, null, 2)}\n`, { mode: 0o600 })
    this.cache = sealed
  }

  /** Any write seals the entries still sitting in the clear, so the file never keeps both. */
  private sealStored(contents: SecretsFile): SecretsFile {
    const plain = Object.entries(contents.ddns)
      .filter((entry): entry is [string, PlainDdnsRecord] => isPlainDdns(entry[1]))
    if (plain.length === 0)
      return contents

    // Warned here rather than at startup: this is the moment credentials exist to protect, so a panel
    // with no DDNS accounts stays quiet. The condition and the message are asserted in the test.
    if (this.usingDefaultDdnsSecret && !this.warnedDefaultSecret) {
      this.warnedDefaultSecret = true
      logger.warn(`ddns: credentials are sealed under the built-in key — set HHOSTED_DDNS_SECRET to protect them if this state directory is ever copied or committed (docs/DDNS.md)`)
    }

    const kdf = contents.ddnsKdf ?? newDdnsKdf()
    const key = this.ddnsKey(kdf)
    const ddns = { ...contents.ddns }
    for (const [accountId, record] of plain)
      ddns[accountId] = sealDdns(accountId, { provider: record.provider, values: record.values }, key)
    return { ...contents, ddns, ddnsKdf: kdf }
  }
}
