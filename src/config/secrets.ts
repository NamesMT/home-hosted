import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import process from 'node:process'
import { writeFileAtomic } from '#src/helpers/atomic'
import { logger } from '#src/helpers/logger'
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
  version: 3
  password: PasswordRecord | null
  apiToken: ApiTokenRecord | null
  telegram: { botToken: string } | null
  /** Per-DDNS-account credentials, keyed by the account id in the config. */
  ddns: Record<string, StoredDdnsRecord>
  /** How the DDNS key is derived; absent until the first sealed write. */
  ddnsKdf: DdnsKdfMeta | null
}

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

export function hashPassword(password: string, options: { now?: number, isDefault?: boolean } = {}): PasswordRecord {
  const salt = crypto.randomBytes(SALT_BYTES)
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: deriveKey(password, salt, COST, KEYLEN).toString('base64'),
    keylen: KEYLEN,
    cost: { ...COST },
    updatedAt: options.now ?? Date.now(),
    ...(options.isDefault === true ? { isDefault: true } : {}),
  }
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

/** Every shape this file has held: sealed, `{ provider, values }`, or a bare field map. */
function readStoredDdns(value: unknown): Record<string, StoredDdnsRecord> {
  if (!isRecord(value))
    return {}
  const out: Record<string, StoredDdnsRecord> = {}
  for (const [accountId, entry] of Object.entries(value)) {
    if (isSealedDdns(entry)) {
      out[accountId] = entry
      continue
    }
    if (!isRecord(entry))
      continue
    const values = readDdnsValues('values' in entry ? entry.values : entry)
    if (Object.keys(values).length === 0)
      continue
    out[accountId] = { plain: true, provider: typeof entry.provider === 'string' ? entry.provider : '', values }
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
  private ddnsKeyCache: { salt: string, key: Buffer } | null = null
  private readonly warnedAccounts = new Set<string>()
  private readonly ddnsSecret: string

  constructor(private readonly file: string, ddnsSecret?: string, private readonly scope: SecretsScope = 'all') {
    const candidate = (ddnsSecret ?? process.env.HHOSTED_DDNS_SECRET ?? '').trim()
    this.ddnsSecret = candidate.length > 0 ? candidate : DEFAULT_DDNS_SECRET
  }

  get path(): string {
    return this.file
  }

  /**
   * Re-reads whenever the file changes on disk, so a password set by
   * `pnpm run set-password` (or another process) takes effect without
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

  get apiToken(): ApiTokenRecord | null {
    return this.load().apiToken
  }

  get apiTokenSet(): boolean {
    return this.apiToken !== null
  }

  /** The readable head of the stored token, or null when none is set. */
  get apiTokenHint(): string | null {
    return this.apiToken?.hint ?? null
  }

  get telegramToken(): string | null {
    return this.load().telegram?.botToken ?? null
  }

  get telegramTokenSet(): boolean {
    return (this.telegramToken ?? '').length > 0
  }

  setPassword(password: string, options: { isDefault?: boolean } = {}): PasswordRecord {
    const record = hashPassword(password, options)
    this.save({ ...this.load(), password: record })
    return record
  }

  /** Creates the default password only when none exists yet. */
  ensureDefaultPassword(password: string): PasswordRecord | null {
    if (this.passwordSet)
      return null
    return this.setPassword(password, { isDefault: true })
  }

  clearPassword(): void {
    this.save({ ...this.load(), password: null })
  }

  setApiToken(token: string): ApiTokenRecord {
    const record = apiTokenRecord(token)
    this.save({ ...this.load(), apiToken: record })
    return record
  }

  clearApiToken(): void {
    this.save({ ...this.load(), apiToken: null })
  }

  setTelegramToken(token: string | null): void {
    const trimmed = token?.trim() ?? ''
    this.save({ ...this.load(), telegram: trimmed.length > 0 ? { botToken: trimmed } : null })
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
    // An entry from before the provider was recorded is accepted for any of them.
    return record.provider.length > 0 && record.provider !== provider ? null : record
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

  private read(): SecretsFile {
    const empty: SecretsFile = { version: 3, password: null, apiToken: null, telegram: null, ddns: {}, ddnsKdf: null }
    if (!fs.existsSync(this.file))
      return this.inScope(empty)
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SecretsFile>
      return this.inScope({
        version: 3,
        // A version-2 file simply has no token, so it reads as "none set".
        password: parsed?.password ?? null,
        apiToken: parsed?.apiToken?.hash ? parsed.apiToken : null,
        telegram: parsed?.telegram?.botToken ? { botToken: parsed.telegram.botToken } : null,
        ddns: readStoredDdns(parsed?.ddns),
        ddnsKdf: readDdnsKdf((parsed as { ddnsKdf?: unknown })?.ddnsKdf),
      })
    }
    catch {
      // A corrupt secrets file must not silently authenticate anyone.
      return this.inScope(empty)
    }
  }

  /** Everything a store does not own is neither read from nor written to its file. */
  private inScope(contents: SecretsFile): SecretsFile {
    if (this.scope === 'global')
      return { ...contents, telegram: null, ddns: {}, ddnsKdf: null }
    if (this.scope === 'workspace')
      return { ...contents, password: null, apiToken: null }
    return contents
  }

  private save(contents: SecretsFile): void {
    const sealed = this.sealStored(this.inScope(contents))
    writeFileAtomic(this.file, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 })
    this.cache = sealed
  }

  /** Any write seals the entries still sitting in the clear, so the file never keeps both. */
  private sealStored(contents: SecretsFile): SecretsFile {
    const plain = Object.entries(contents.ddns)
      .filter((entry): entry is [string, PlainDdnsRecord] => isPlainDdns(entry[1]))
    if (plain.length === 0)
      return contents

    const kdf = contents.ddnsKdf ?? newDdnsKdf()
    const key = this.ddnsKey(kdf)
    const ddns = { ...contents.ddns }
    for (const [accountId, record] of plain)
      ddns[accountId] = sealDdns(accountId, { provider: record.provider, values: record.values }, key)
    return { ...contents, ddns, ddnsKdf: kdf }
  }
}
