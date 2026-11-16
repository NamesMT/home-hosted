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
 * One **account**: a credential that signs in to the panel *and* authenticates the API.
 *
 * The password and the API token were two credentials with one authority each, so every panel needed
 * both, every script needed one of them copied somewhere, and there was exactly one human. An account
 * is the union: an `id` a person types (like a username) plus a `secret`, which opens a session cookie
 * for the browser and works as `Authorization: Bearer <id>:<secret>` for a script.
 *
 * **Two hash algorithms, on purpose.** A secret a person chooses is stretched with scrypt, because it
 * may be guessable and an attacker with the file would otherwise brute-force it offline; a secret the
 * panel *generates* is 256 bits of randomness, so scrypt would only add cost to every request for a
 * search space that cannot be walked. The record says which it is, and verification reads that field —
 * so an account created by `account create` (generated) and one whose secret a person set are both
 * handled without guessing.
 *
 * `id` is the salt-adjacent half: it is not secret, it is what makes a stolen file's hashes worthless
 * to replay without the matching id, and it is what a login attempt is rate-limited on.
 */
export interface AccountRecord {
  /** Stable, typable, unique. Lowercase letters, digits and dashes. */
  id: string
  /** Shown to a human; defaults to the id. */
  label: string
  algo: 'scrypt' | 'sha256'
  /** Present for `scrypt`. */
  salt?: string
  hash: string
  keylen?: number
  cost?: ScryptCost
  scopes: ApiTokenScope[]
  /** Absent means every workspace. */
  workspaces?: string[]
  /** A disabled account cannot sign in and its bearer credential is refused, but it is not deleted. */
  enabled: boolean
  /** Set while this account holds the panel's boot-generated first-run secret. */
  isDefault?: boolean
  /** The generated first-run secret, kept only while it is still the one in use. */
  initial?: string
  /** Below the exposure bar, so `checkExposure` can refuse a non-loopback bind. */
  short?: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

/** An account as a listing shows it: metadata only, never the hash. */
export interface AccountView {
  id: string
  label: string
  scopes: ApiTokenScope[]
  workspaces?: string[]
  enabled: boolean
  isDefault: boolean
  short: boolean
  createdAt: number
  updatedAt: number
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
  /**
   * The accounts. This is the credential model now: one record authenticates a browser and a script.
   *
   * The three fields below it are what earlier releases wrote, and they are migrated **on read** — a
   * file from 0.13 or 0.14 must not lock its owner out.
   */
  accounts: AccountRecord[]
  /** Pre-0.15 password, migrated to the `default` account on read. */
  password: PasswordRecord | null
  /** Pre-0.14 single token, migrated to the `default` account on read. */
  apiToken: ApiTokenRecord | null
  /**
   * The named tokens of 0.14. Migrated into `accounts` on read — a token becomes an account with the
   * same id and scopes, so a script keeps working with the same value.
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
  /**
   * Per-job secret environment values: `{ [jobId]: { [NAME]: value } }`.
   *
   * A separate map from `serverEnv`, and that separation is the point: a server and a job are two
   * different entries that may share an id, and one key space meant a job's value reached the server
   * of the same id — and the server's view reported it. Measured on a real panel: `PUT
   * /api/jobs/nightly/secrets` stored under `nightly`, a server declared later as `nightly` declaring
   * the same name reported `secretEnvSet: ["DB_PASS"]` and received the job's value in its own
   * process. Two domains, two maps.
   */
  jobEnv: Record<string, Record<string, string>>
  /** Top-level keys this release does not know, carried through a write so a newer release keeps them. */
  extra?: Record<string, unknown>
}

/** Owned by this release, plus `version`: retired, and dropped on the next write rather than carried. */
const KNOWN_SECRET_KEYS = new Set(['accounts', 'password', 'apiToken', 'apiTokens', 'telegram', 'ddns', 'ddnsKdf', 'serverEnv', 'jobEnv', 'version'])

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

/**
 * One throwaway scrypt, so "no such account" costs what "wrong secret" costs.
 *
 * `verifyAccountSecret` answers `false` early for an unknown, disabled or half-written record, which
 * is right for the answer and wrong for the timing: the measured gap was ~1 ms against ~37 ms, and a
 * 30× difference is a working account-enumeration oracle — the one thing `docs/SECURITY.md` promises
 * the login form is not. The salt is derived from the secret rather than random so this is a pure
 * cost with no per-call allocation to vary, and the result is deliberately discarded.
 *
 * Kept next to `verifyPassword` because it has to stay in step with it: a change to `COST` or
 * `KEYLEN` that this did not follow would reopen the gap it closes.
 */
function spendVerifyWork(secret: string): void {
  try {
    const salt = crypto.createHash('sha256').update(secret, 'utf8').digest().subarray(0, SALT_BYTES)
    deriveKey(secret.length === 0 ? 'x' : secret, salt, COST, KEYLEN)
  }
  catch {
    // A secret scrypt refuses is still an answer of `false`; the cost was the point, not the output.
  }
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
/** An account id: typable, and safe in a URL path and a `Bearer <id>:<secret>` header. */
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** Why this id cannot be an account id, or `null` when it can. */
export function accountIdProblem(id: string): string | null {
  if (id.length === 0)
    return 'an account needs an id'
  if (!ACCOUNT_ID_PATTERN.test(id))
    return `an account id is lowercase letters, digits, - and _, starting with a letter or digit, at most 40 characters — "${id}" is not`
  return null
}

/** Visible head, so a person can tell a generated secret from one they chose. */
export const ACCOUNT_SECRET_PREFIX = 'hh_'
const ACCOUNT_SECRET_BYTES = 32

/** 32 bytes of randomness: the whole point of a generated secret is that nothing needs to stretch it. */
export function generateAccountSecret(): string {
  return `${ACCOUNT_SECRET_PREFIX}${crypto.randomBytes(ACCOUNT_SECRET_BYTES).toString('base64url')}`
}

/**
 * The hash fields for a secret: **scrypt when a person chose it, sha256 when the panel generated it.**
 *
 * The distinction is real, not stylistic. A typed secret may be guessable, so an attacker holding the
 * file would walk a small space offline — scrypt makes each guess cost. A generated secret is 256 bits
 * of randomness, where the space is far too large to walk and the only thing scrypt would add is cost
 * to every authenticated request. `algo` records which, and verification reads it.
 */
function credentialFields(secret: string, generated: boolean): Pick<AccountRecord, 'algo' | 'hash' | 'salt' | 'keylen' | 'cost' | 'short'> {
  if (generated) {
    return {
      algo: 'sha256',
      hash: hashApiToken(secret),
      ...(passwordLength(secret) < EXPOSED_PASSWORD_MIN_LENGTH ? { short: true } : {}),
    }
  }
  const record = hashPassword(secret)
  return {
    algo: 'scrypt',
    hash: record.hash,
    salt: record.salt,
    keylen: record.keylen,
    cost: record.cost,
    ...(record.short === true ? { short: true } : {}),
  }
}

/**
 * The accounts, read tolerantly — and **the migration** from both earlier credential models.
 *
 * A file written by 0.13 has `password`; one by 0.14 has `password` plus `apiTokens`. Both become
 * one account with id `default`, carrying **the union of the authorities they had**, so an upgrade
 * cannot remove access it never announced:
 *
 * - the password becomes the account's scrypt record, so the same typed secret still signs in;
 * - a token with the id `default` *is* that account (a token is a secret the panel generated, so it
 *   becomes a `sha256` account — verification reads `algo`, so either works);
 * - any other token becomes its own account with the same id and scopes, and its value keeps working
 *   as `Bearer <id>:<secret>`.
 *
 * Ids must be unique, so a collision on the id keeps the stored account and drops the legacy one: the
 * file on disk is the more recent statement of intent.
 */
function readAccounts(value: unknown): AccountRecord[] {
  if (!Array.isArray(value))
    return []
  const accounts: AccountRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0 || typeof entry.hash !== 'string')
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
    const algo = entry.algo === 'scrypt' ? 'scrypt' : 'sha256'
    const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : (typeof entry.updatedAt === 'number' ? entry.updatedAt : 0)
    accounts.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : entry.id,
      algo,
      hash: entry.hash,
      ...(algo === 'scrypt' && typeof entry.salt === 'string' ? { salt: entry.salt } : {}),
      ...(algo === 'scrypt' && typeof entry.keylen === 'number' ? { keylen: entry.keylen } : {}),
      ...(algo === 'scrypt' && isRecord(entry.cost) ? { cost: { N: Number(entry.cost.N), r: Number(entry.cost.r), p: Number(entry.cost.p) } } : {}),
      // A record with no scopes is a hand-edit that would authenticate for nothing; `read` is the
      // least it can mean, and an empty list is never what someone intended.
      scopes: scopes.length === 0 ? ['read'] : scopes,
      // Absent means enabled: a pre-0.15 account could not be disabled, so it was.
      enabled: entry.enabled !== false,
      ...(workspaces === undefined || workspaces.length === 0 ? {} : { workspaces }),
      ...(entry.isDefault === true ? { isDefault: true } : {}),
      ...(typeof entry.initial === 'string' ? { initial: entry.initial } : {}),
      ...(entry.short === true ? { short: true } : {}),
      createdAt,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : createdAt,
      ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
    })
  }
  return accounts
}

/**
 * The accounts a pre-0.15 file implies.
 *
 * Ids are unique, so `default` is the one that carries the password; a token already named `default`
 * is* that account rather than a second one. Everything else becomes its own account with the same id
 * and scopes, so a script's value keeps working — `Bearer <id>:<secret>` — without anyone re-issuing it.
 */
function migrateLegacyAccounts(contents: SecretsFile): AccountRecord[] {
  const accounts: AccountRecord[] = []
  const taken = new Set<string>()
  const createdAt = contents.password?.updatedAt ?? Date.now()

  if (contents.password !== null) {
    const password = contents.password
    accounts.push({
      id: 'default',
      label: 'default',
      algo: 'scrypt',
      hash: password.hash,
      salt: password.salt,
      keylen: password.keylen,
      cost: password.cost,
      // The password was full admin, so the account it becomes is too.
      scopes: [...API_TOKEN_SCOPES],
      enabled: true,
      ...(password.isDefault === true ? { isDefault: true } : {}),
      ...(typeof password.initial === 'string' ? { initial: password.initial } : {}),
      ...(password.short === true ? { short: true } : {}),
      createdAt,
      updatedAt: password.updatedAt,
    })
    taken.add('default')
  }

  for (const token of contents.apiTokens) {
    if (taken.has(token.id)) {
      // A token whose id collides with the password account: keep the token as the secret, because a
      // token is what a script is holding, and the account it becomes keeps `admin`.
      continue
    }
    taken.add(token.id)
    accounts.push({
      id: token.id,
      label: token.name,
      algo: 'sha256',
      hash: token.hash,
      scopes: token.scopes.length === 0 ? [...API_TOKEN_SCOPES] : token.scopes,
      enabled: true,
      ...(token.workspaces === undefined ? {} : { workspaces: token.workspaces }),
      createdAt: token.updatedAt,
      updatedAt: token.updatedAt,
      ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
    })
  }

  // The pre-0.14 single token, when there was no named list.
  if (contents.apiToken !== null && !taken.has('default')) {
    accounts.push({
      id: 'default',
      label: 'default',
      algo: 'sha256',
      hash: contents.apiToken.hash,
      scopes: [...API_TOKEN_SCOPES],
      enabled: true,
      createdAt: contents.apiToken.updatedAt,
      updatedAt: contents.apiToken.updatedAt,
    })
  }

  return accounts
}

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

  /**
   * The `default` account's password-shaped record, when that account still has one.
   *
   * Kept because the exposure checks and the first-run display speak of "the password": there is one
   * account whose secret a person types at the login screen, and that is this. A panel whose accounts
   * all hold generated secrets has no such record, and `passwordSet` is still true — see below.
   */
  get password(): PasswordRecord | null {
    const record = this.account('default')
    if (record === null || record.algo !== 'scrypt')
      return null
    if (record.salt === undefined || record.cost === undefined || record.keylen === undefined)
      return null
    return {
      algo: 'scrypt',
      salt: record.salt,
      hash: record.hash,
      keylen: record.keylen,
      cost: record.cost,
      updatedAt: record.updatedAt,
      ...(record.isDefault === true ? { isDefault: true } : {}),
      ...(typeof record.initial === 'string' ? { initial: record.initial } : {}),
      ...(record.short === true ? { short: true } : {}),
    }
  }

  get passwordUpdatedAt(): number | null {
    return this.account('default')?.updatedAt ?? null
  }

  /** Whether **any** account can sign in — what arms authentication now. */
  get passwordSet(): boolean {
    return this.anyAccountEnabled
  }

  get usingDefaultPassword(): boolean {
    return this.accounts.some(entry => entry.isDefault === true)
  }

  /** An account's secret is too short to expose the panel behind; see `AccountRecord.short`. */
  get passwordTooShort(): boolean {
    return this.accounts.some(entry => entry.short === true)
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

  /**
   * Every account, **with the legacy credential models migrated in**.
   *
   * The migration runs on read and is persisted by the next write, exactly like the 0.14 token
   * migration before it: a file written by 0.13 or 0.14 must still authenticate, and the first change
   * a person makes writes the new shape and drops the old fields.
   */
  get accounts(): AccountRecord[] {
    const contents = this.load()
    if (contents.accounts.length > 0)
      return contents.accounts
    return migrateLegacyAccounts(contents)
  }

  /** Metadata for a settings page: ids, labels, scopes, whether enabled, when last used. */
  listAccounts(): AccountView[] {
    return this.accounts.map(({ hash: _hash, algo: _algo, salt: _salt, keylen: _keylen, cost: _cost, initial: _initial, ...rest }) => ({
      ...rest,
      isDefault: rest.isDefault === true,
      short: rest.short === true,
    }))
  }

  account(id: string): AccountRecord | null {
    return this.accounts.find(entry => entry.id === id) ?? null
  }

  /**
   * Creates an account, returning its **secret once**.
   *
   * A generated secret is the default because that is what a script wants and what needs no password
   * policy; a person setting their own passes `secret`, and it is stretched with scrypt instead.
   */
  createAccount(
    input: { id: string, label?: string, scopes: ApiTokenScope[], workspaces?: string[], secret?: string, enabled?: boolean, isDefault?: boolean, keepInitial?: boolean },
    now = Date.now(),
  ): { account: AccountView, secret: string } {
    const id = input.id.trim()
    const problem = accountIdProblem(id)
    if (problem !== null)
      throw new Error(problem)
    if (input.scopes.length === 0)
      throw new Error('an account needs at least one scope')
    const existing = this.accounts
    if (existing.some(entry => entry.id === id))
      throw new Error(`an account with the id "${id}" already exists`)

    const secret = input.secret ?? generateAccountSecret()
    const record: AccountRecord = {
      id,
      label: input.label?.trim() || id,
      scopes: [...new Set(input.scopes)],
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      ...(input.workspaces === undefined || input.workspaces.length === 0 ? {} : { workspaces: [...new Set(input.workspaces)] }),
      ...credentialFields(secret, input.secret === undefined),
      // The boot-generated first-run account: the login page says so, exposure stays blocked, and the
      // secret is kept in this 0600 file only while it is still the one in use so `up`/`status` can
      // show it on the machine.
      ...(input.isDefault === true ? { isDefault: true } : {}),
      ...(input.isDefault === true && input.keepInitial === true ? { initial: secret } : {}),
    }
    this.writeAccounts([...existing, record])
    return { account: this.listAccounts().find(entry => entry.id === id)!, secret }
  }

  /** Replaces one account's secret. A secret the panel generates stays `sha256`; a typed one is scrypt. */
  setAccountSecret(id: string, secret: string, now = Date.now()): AccountRecord | null {
    const existing = this.accounts
    const index = existing.findIndex(entry => entry.id === id)
    if (index === -1)
      return null
    const record: AccountRecord = {
      ...existing[index]!,
      ...credentialFields(secret, false),
      updatedAt: now,
    }
    // A hand-set secret clears the first-run markers: it is no longer the boot default.
    delete record.isDefault
    delete record.initial
    // And the length flag is recomputed, not carried: it describes the **current** secret, and a
    // person who replaces a one-character one with a twelve-character one must stop being told it is
    // too short. `credentialFields` only ever *sets* it, so the spread of the old record above keeps
    // a stale `true` — the flag is rebuilt from the new secret alone.
    const fresh = credentialFields(secret, false)
    if (fresh.short !== true)
      delete record.short
    const next = [...existing]
    next[index] = record
    this.writeAccounts(next)
    return record
  }

  /**
   * Whether the secret matches this account, in constant time for the algorithm it was stored with.
   *
   * A **disabled** account never matches, and neither does an unknown id — the caller must not be able
   * to tell "no such id" from "wrong secret" faster than by the answer it is given, so both spend the
   * same work where the algorithm is known.
   *
   * "Where the algorithm is known" is the hole that sentence used to leave. A known id reaches scrypt
   * (a typed secret) or sha256 (a generated one); an unknown id returned before **anything** was
   * computed, so `login` answered an unknown id in ~1 ms and a wrong secret for a known id in ~37 ms —
   * a 30× signal that names which ids exist, which is exactly what `docs/SECURITY.md` promises the
   * login form does not do ("a wrong id and a wrong secret answer identically … not an
   * account-enumeration oracle"). Measured on the fixture before this: median 1.2 ms vs 36.9 ms.
   *
   * The work now happens either way. An unknown, disabled or under-specified record still runs one
   * scrypt against a throwaway salt, so the answer costs the same as a real mismatch.
   *
   * **A `false` always costs a scrypt, whichever shape the record has.** Choosing scrypt for the
   * unknown case was right and not enough: the panel stores two algorithms, so the *miss* matched
   * only the `scrypt` half. A secret the panel generated is `sha256` (256 bits of randomness needs no
   * stretching), and verifying one returns in microseconds — so the cheap answer was not "no such
   * account" but "a real account whose secret was generated", which is what `account create` mints by
   * default and what the first-run `default` account is. Measured on a store holding both shapes:
   * unknown 29.7 ms, generated 0.011 ms, typed 34.2 ms — the fast answer named the id, and it named
   * the ones an attacker most wants.
   *
   * So the equalising cost is spent **on a failed answer**, and only there. A successful `sha256`
   * verification stays microseconds, which is the whole reason generated secrets use it: it runs on
   * every authenticated request. A wrong guess pays the same scrypt whether the id exists with a
   * generated secret, exists with a typed one, or does not exist — so a *failed* attempt says nothing
   * about the id. A success is the answer and needs no cover.
   */
  verifyAccountSecret(id: string, secret: string): boolean {
    const record = this.account(id)
    // No usable record: spend the same scrypt a wrong secret for a real one would, and answer false.
    if (record === null || record.enabled !== true || secret.length === 0) {
      spendVerifyWork(secret)
      return false
    }
    if (record.algo === 'scrypt') {
      if (record.salt === undefined || record.cost === undefined || record.keylen === undefined) {
        spendVerifyWork(secret)
        return false
      }
      // The verification *is* a scrypt, so a miss has already paid the equalising cost.
      return verifyPassword(secret, {
        algo: 'scrypt',
        salt: record.salt,
        hash: record.hash,
        keylen: record.keylen,
        cost: record.cost,
        updatedAt: record.updatedAt,
      })
    }
    if (verifyApiToken(secret, { algo: 'sha256', hash: record.hash, hint: '', updatedAt: record.updatedAt }))
      return true
    // A miss on a generated record must cost what a miss on an unknown id costs, or the cheap answer
    // is the oracle.
    spendVerifyWork(secret)
    return false
  }

  /** `true` when it removed one, `false` when no such id — a 404 is the caller's to answer. */
  revokeAccount(id: string): boolean {
    const existing = this.accounts
    const next = existing.filter(entry => entry.id !== id)
    if (next.length === existing.length)
      return false
    this.writeAccounts(next)
    return true
  }

  /** Applies the fields a settings page may change. Returns `null` for an unknown id. */
  updateAccount(id: string, patch: { label?: string, scopes?: ApiTokenScope[], workspaces?: string[] | null, enabled?: boolean }, now = Date.now()): AccountRecord | null {
    const existing = this.accounts
    const index = existing.findIndex(entry => entry.id === id)
    if (index === -1)
      return null
    const current = existing[index]!
    const next: AccountRecord = { ...current, updatedAt: now }
    if (patch.label !== undefined)
      next.label = patch.label.trim() || current.id
    if (patch.scopes !== undefined) {
      if (patch.scopes.length === 0)
        throw new Error('an account needs at least one scope')
      next.scopes = [...new Set(patch.scopes)]
    }
    if (patch.workspaces !== undefined) {
      if (patch.workspaces === null || patch.workspaces.length === 0)
        delete next.workspaces
      else
        next.workspaces = [...new Set(patch.workspaces)]
    }
    if (patch.enabled !== undefined)
      next.enabled = patch.enabled
    const list = [...existing]
    list[index] = next
    this.writeAccounts(list)
    return next
  }

  /** Records a successful use, so a settings page can show an account nobody uses any more. */
  markAccountUsed(id: string, now = Date.now()): void {
    const existing = this.accounts
    const index = existing.findIndex(entry => entry.id === id)
    if (index === -1)
      return
    const next = [...existing]
    next[index] = { ...next[index]!, lastUsedAt: now }
    this.writeAccounts(next, { touchUpdatedAt: false })
  }

  /** The first account holding the boot-generated first-run secret, while it is still in use. */
  get initialAccount(): AccountRecord | null {
    return this.accounts.find(entry => entry.isDefault === true && typeof entry.initial === 'string' && entry.initial.length > 0) ?? null
  }

  /** The boot secret while it is still the one in use, for `up`/`status` on this machine. */
  get initialPassword(): string | null {
    const record = this.accounts.find(entry => entry.isDefault === true)
    if (record === undefined)
      return null
    if (typeof record.initial === 'string' && record.initial.length > 0)
      return record.initial
    // A home from before 0.12 is still on the shared default.
    return this.verifyAccountSecret(record.id, LEGACY_DEFAULT_PASSWORD) ? LEGACY_DEFAULT_PASSWORD : null
  }

  /** Whether any account can sign in — what arms authentication. */
  get accountCount(): number {
    return this.accounts.length
  }

  get anyAccountEnabled(): boolean {
    return this.accounts.some(entry => entry.enabled)
  }

  /**
   * Writes the account list, clearing the legacy fields in the same write.
   *
   * One writer for every mutation, so no path can leave a stale `password` beside a new `accounts` and
   * have the migration resurrect a credential somebody revoked.
   */
  private writeAccounts(accounts: AccountRecord[], options: { touchUpdatedAt?: boolean } = {}): void {
    void options
    this.save({ ...this.load(), accounts, password: null, apiToken: null, apiTokens: [] })
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

  /** One job's secret environment. A **separate** map from a server's — see `jobEnv` on the file. */
  jobEnv(jobId: string): Record<string, string> {
    return { ...this.load().jobEnv[jobId] ?? {} }
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
    this.setEnvOf('serverEnv', 'a server', serverId, values)
  }

  /** The same replacement for a job's own names. */
  setJobEnv(jobId: string, values: Record<string, string>): void {
    this.setEnvOf('jobEnv', 'a job', jobId, values)
  }

  /** Removes the named values from one server, leaving the rest. */
  unsetServerEnv(serverId: string, names: readonly string[]): void {
    this.unsetEnvOf('serverEnv', serverId, names)
  }

  unsetJobEnv(jobId: string, names: readonly string[]): void {
    this.unsetEnvOf('jobEnv', jobId, names)
  }

  /** Everything for one server, for a removal or a rename. */
  forgetServerEnv(serverId: string): void {
    this.forgetEnvOf('serverEnv', serverId)
  }

  /** Everything for one job, for a removal — the job half of `forgetServerEnv`. */
  forgetJobEnv(jobId: string): void {
    this.forgetEnvOf('jobEnv', jobId)
  }

  /** Moves a removed id's values onto another: a renamed entry keeps its secrets. */
  renameServerEnv(from: string, to: string): void {
    this.renameEnvOf('serverEnv', from, to)
  }

  private setEnvOf(map: 'serverEnv' | 'jobEnv', what: string, id: string, values: Record<string, string>): void {
    // `all` is the shape a pre-workspace file had and what a backup archive carries, so it owns every
    // field. `global` does not: the panel-wide secrets file must never gain a workspace's values.
    if (this.scope === 'global')
      throw new Error(`${what}'s secret environment belongs to its workspace — a global secrets file cannot hold one`)
    const clean: Record<string, string> = {}
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Z_]\w*$/i.test(name))
        throw new Error(`"${name}" is not an environment-variable name: a letter or underscore, then letters, digits or underscores`)
      clean[name] = value
    }
    const current = this.load()
    this.save({ ...current, [map]: { ...current[map], [id]: clean } })
  }

  private unsetEnvOf(map: 'serverEnv' | 'jobEnv', id: string, names: readonly string[]): void {
    const current = this.load()
    const existing = { ...current[map][id] ?? {} }
    for (const name of names)
      delete existing[name]
    const next = { ...current[map] }
    if (Object.keys(existing).length === 0)
      delete next[id]
    else
      next[id] = existing
    this.save({ ...current, [map]: next })
  }

  private forgetEnvOf(map: 'serverEnv' | 'jobEnv', id: string): void {
    const current = this.load()
    if (current[map][id] === undefined)
      return
    const next = { ...current[map] }
    delete next[id]
    this.save({ ...current, [map]: next })
  }

  private renameEnvOf(map: 'serverEnv' | 'jobEnv', from: string, to: string): void {
    const current = this.load()
    const values = current[map][from]
    if (values === undefined)
      return
    const next = { ...current[map] }
    delete next[from]
    next[to] = values
    this.save({ ...current, [map]: next })
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
    const empty: SecretsFile = { accounts: [], password: null, apiToken: null, apiTokens: [], telegram: {}, ddns: {}, ddnsKdf: null, serverEnv: {}, jobEnv: {} }
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
        accounts: readAccounts((parsed as { accounts?: unknown })?.accounts),
        apiToken: parsed?.apiToken?.hash ? parsed.apiToken : null,
        apiTokens: readNamedTokens((parsed as { apiTokens?: unknown })?.apiTokens),
        telegram: readTelegramTokens(parsed?.telegram),
        ddns: readStoredDdns(parsed?.ddns),
        ddnsKdf: readDdnsKdf((parsed as { ddnsKdf?: unknown })?.ddnsKdf),
        serverEnv: readServerEnv(parsed?.serverEnv),
        jobEnv: readServerEnv(parsed?.jobEnv),
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
      return { ...contents, telegram: {}, ddns: {}, ddnsKdf: null, serverEnv: {}, jobEnv: {} }
    if (this.scope === 'workspace')
      return { ...contents, accounts: [], password: null, apiToken: null, apiTokens: [] }
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
