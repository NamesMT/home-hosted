import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeFileAtomic } from '#src/helpers/atomic'

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

interface SecretsFile {
  version: 3
  password: PasswordRecord | null
  apiToken: ApiTokenRecord | null
  telegram: { botToken: string } | null
  /** Per-DDNS-account provider credentials, keyed by the account id in the config. */
  ddns: Record<string, Record<string, string>>
}

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

/**
 * Only account → string map → string survives; a hand-edited file with a number
 * or a nested object in there reads as "no credentials" instead of throwing.
 */
function readDdnsCredentials(value: unknown): Record<string, Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [accountId, fields] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields))
      continue
    const record: Record<string, string> = {}
    for (const [key, field] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof field === 'string' && field.length > 0)
        record[key] = field
    }
    if (Object.keys(record).length > 0)
      out[accountId] = record
  }
  return out
}

/**
 * The password hash and the API token are secrets, so they live outside
 * `servers.config.json` (which is tracked) in a 0600 file that is git-ignored.
 */
export class SecretsStore {
  private cache: SecretsFile | null = null
  private cacheKey = ''

  constructor(private readonly file: string) {}

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

  getDdnsCredentials(accountId: string): Record<string, string> | null {
    return this.load().ddns[accountId] ?? null
  }

  get ddnsAccountIds(): string[] {
    return Object.keys(this.load().ddns)
  }

  /** An empty field is dropped, so clearing every field forgets the account. */
  setDdnsCredentials(accountId: string, credentials: Record<string, string>): void {
    const entries = Object.entries(credentials)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0)
    const ddns = { ...this.load().ddns }
    if (entries.length === 0)
      delete ddns[accountId]
    else
      ddns[accountId] = Object.fromEntries(entries)
    this.save({ ...this.load(), ddns })
  }

  clearDdnsCredentials(accountId: string): void {
    const ddns = { ...this.load().ddns }
    delete ddns[accountId]
    this.save({ ...this.load(), ddns })
  }

  private read(): SecretsFile {
    if (!fs.existsSync(this.file))
      return { version: 3, password: null, apiToken: null, telegram: null, ddns: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SecretsFile>
      return {
        version: 3,
        // A version-2 file simply has no token, so it reads as "none set".
        password: parsed?.password ?? null,
        apiToken: parsed?.apiToken?.hash ? parsed.apiToken : null,
        telegram: parsed?.telegram?.botToken ? { botToken: parsed.telegram.botToken } : null,
        ddns: readDdnsCredentials(parsed?.ddns),
      }
    }
    catch {
      // A corrupt secrets file must not silently authenticate anyone.
      return { version: 3, password: null, apiToken: null, telegram: null, ddns: {} }
    }
  }

  private save(contents: SecretsFile): void {
    writeFileAtomic(this.file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
    this.cache = contents
  }
}
