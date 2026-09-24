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

interface SecretsFile {
  version: 2
  password: PasswordRecord | null
  telegram: { botToken: string } | null
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

/**
 * The password hash is a secret, so it lives outside `servers.config.json`
 * (which is tracked) in a 0600 file that is git-ignored.
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

  setTelegramToken(token: string | null): void {
    const trimmed = token?.trim() ?? ''
    this.save({ ...this.load(), telegram: trimmed.length > 0 ? { botToken: trimmed } : null })
  }

  private read(): SecretsFile {
    if (!fs.existsSync(this.file))
      return { version: 2, password: null, telegram: null }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SecretsFile>
      return {
        version: 2,
        password: parsed?.password ?? null,
        telegram: parsed?.telegram?.botToken ? { botToken: parsed.telegram.botToken } : null,
      }
    }
    catch {
      // A corrupt secrets file must not silently authenticate anyone.
      return { version: 2, password: null, telegram: null }
    }
  }

  private save(contents: SecretsFile): void {
    writeFileAtomic(this.file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
    this.cache = contents
  }
}
