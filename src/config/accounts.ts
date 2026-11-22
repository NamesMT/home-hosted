/**
 * An account: a credential that signs in to the panel *and* authenticates the API.
 *
 * Two hash algorithms on purpose — a secret a person chooses is stretched with scrypt, because it may be
 * guessable and an attacker holding the file would otherwise walk it offline; a secret the panel
 * generates* is 256 bits of randomness, where scrypt would only add cost to every request. The record
 * says which, and verification reads that field.
 *
 * The store lives in `secrets.ts` beside the other secrets; this is the identity and hashing layer it
 * calls.
 */
import type { ApiTokenScope } from '#src/shared/api-scopes'
import type { AccountRecord, SecretsFile } from './secrets'
import crypto from 'node:crypto'
import { API_TOKEN_SCOPES } from '#src/shared/api-scopes'
import { EXPOSED_PASSWORD_MIN_LENGTH, passwordLength } from '#src/shared/password-policy'
import { isRecord } from '#src/shared/shape'
import { hashApiToken, hashPassword } from './secrets'

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
const ACCOUNT_SECRET_PREFIX = 'hh_'
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
export function credentialFields(secret: string, generated: boolean): Pick<AccountRecord, 'algo' | 'hash' | 'salt' | 'keylen' | 'cost' | 'short'> {
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
export function readAccounts(value: unknown): AccountRecord[] {
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
export function migrateLegacyAccounts(contents: SecretsFile): AccountRecord[] {
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
