import { isRecord } from '#src/shared/shape'

export type SecretScope = 'global' | 'workspace'

export interface SecretPart {
  /** The leaf id: `password`, `apiToken`, `telegram` (bot tokens by destination), `ddns`, or a future top-level key. */
  key: string
  /** The top-level file keys this part carries. `ddns` carries `['ddns', 'ddnsKdf']`. */
  fields: string[]
  scope: SecretScope
}

/** Every secret this release knows about, set or not — the view lists the slots so a person sees one. */
export const KNOWN_SECRET_KEYS: Record<SecretScope, string[]> = {
  global: ['password', 'apiToken'],
  workspace: ['telegram', 'ddns'],
}

/** Where a secret this release knows lives. Everything else is scoped by its own file. */
const KNOWN_SCOPES: Record<string, SecretScope> = {
  password: 'global',
  apiToken: 'global',
  telegram: 'workspace',
  ddns: 'workspace',
}

/** A part carrying more than its own key: `ddnsKdf` is how the sealed DDNS entries are opened. */
const EXTRA_FIELDS: Record<string, string[]> = { ddns: ['ddns', 'ddnsKdf'] }

/**
 * The parts of one scope, in a stable order: the known parts first in the fixed order
 * password, apiToken (global) / telegram, ddns (workspace) — then any other top-level
 * key present in `present`, sorted, as its own part with `fields: [key]`.
 *
 * An unknown key is taken as belonging to the scope being asked about, because the file
 * it was read from is the only evidence of where it lives: this release does not know the
 * key, so classifying it by name would drop a future *global* secret on the floor.
 */
export function secretParts(scope: SecretScope, present: string[]): SecretPart[] {
  const keys = new Set(present)
  const known = KNOWN_SECRET_KEYS[scope]
  const parts = known
    .filter(key => keys.has(key))
    .map(key => ({ key, fields: EXTRA_FIELDS[key] ?? [key], scope }))
  // A key another part carries (`ddnsKdf`) is not a secret of its own; it is offered only
  // when the part that owns it is missing, so nothing in the file becomes unreachable.
  const consumed = new Set(parts.flatMap(part => part.fields))
  const rest = [...keys]
    .filter(key => KNOWN_SCOPES[key] === undefined && !known.includes(key) && !consumed.has(key))
    .sort()
  return [...parts, ...rest.map(key => ({ key, fields: [key], scope }))]
}

/** The top-level keys of a raw secrets document that hold a non-null value. */
export function presentSecretKeys(source: Record<string, unknown>): string[] {
  return Object.entries(source)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => key)
}

/**
 * A JSON string carrying only `fields`, taken from `source`. Returns null when `source`
 * carries none of them. Always includes a field whose value is `null` ONLY if it is
 * present as a key and non-null; a null/absent field is omitted.
 */
export function pickSecrets(source: Record<string, unknown>, fields: string[]): string | null {
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    const value = source[field]
    if (value !== null && value !== undefined)
      picked[field] = withoutFirstRunPassword(value)
  }
  return Object.keys(picked).length === 0 ? null : JSON.stringify(picked)
}

/**
 * Drops `password.initial` — the generated first-run password, which the live file keeps so `up` and
 * `status` can show it on the machine.
 *
 * An archive is a copy *off* the box: unencrypted unless a password was given, and the docs recommend
 * keeping it elsewhere, so carrying the plaintext there hands a reader a working credential the hash
 * beside it exists to avoid. The hash restores a password, which is all a restore needs.
 */
function withoutFirstRunPassword(value: unknown): unknown {
  if (!isRecord(value) || !('initial' in value))
    return value
  const { initial: _initial, ...rest } = value
  return rest
}

/**
 * The same removal, applied to a whole secrets **document** rather than one field's value.
 *
 * `pickSecrets` already drops the field, but a backup that selects every secret copies the file
 * whole and so bypassed it. This is that whole-file path: the document keeps every other key —
 * including `null` slots and keys this release does not know — and differs only in that
 * `password.initial` is gone. Returns `null` when the text is not a JSON object, so the caller can
 * fall back to its ordinary copy.
 */
export function withoutInitialPassword(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!isRecord(parsed) || !('password' in parsed))
    return null
  return `${JSON.stringify({ ...parsed, password: withoutFirstRunPassword(parsed.password) })}\n`
}

/** Parses a secrets document, tolerating anything: not-an-object, or broken JSON returns {}. */
export function parseSecrets(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

/**
 * Merges `piece` into `current`, changing ONLY the fields in `fields` — every other key
 * of `current` is preserved (this is what stops restoring the Telegram token from wiping
 * the DDNS credentials). A field that is absent from `piece` is also DELETED from the
 * result, so restoring an older archive that predates a secret clears it rather than
 * leaving a stale value. Returns a new object; does not mutate its arguments.
 */
export function mergeSecrets(current: Record<string, unknown>, piece: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const merged = { ...current }
  for (const field of fields) {
    const value = piece[field]
    if (value === null || value === undefined)
      delete merged[field]
    else
      merged[field] = value
  }
  return merged
}
