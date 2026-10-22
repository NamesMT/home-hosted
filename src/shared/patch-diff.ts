import type { ServerConfig } from './contracts'

/** Groups whose patch form is merged into the file rather than replacing it. */
const NESTED_GROUPS = ['restart', 'health', 'stop'] as const

export type Patch = Record<string, unknown>

/**
 * A `null` counts as "nothing here" wherever it sits, and key order never matters.
 *
 * A form builds its own copy of every group, so a field the config does not carry
 * comes back as `null` — or as a `null` member inside `health.http`. To the store
 * those are the same "unset", so they have to compare equal, or a page nobody has
 * touched reports the whole group as changed (a freshly opened console editor
 * listed `health.http.path  / → /` for exactly this reason).
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const members: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined || member === null)
        continue
      members[key] = normalize(member)
    }
    return members
  }
  return value ?? null
}

/**
 * Keeps only the fields that differ from `current`.
 *
 * Nested groups list only the sub-keys that changed, which is what lets the
 * server merge a partial patch instead of replacing the whole group. Every
 * comparison goes through `same`, including the one inside a group: `health.http`
 * is an object, so comparing those members by reference reported the whole group
 * as changed on a form nobody had touched, and a `null` the form carries where
 * the config has no key at all is the same "nothing here" the server would clear.
 */
export function diffFields(current: Patch, next: Patch, nested: readonly string[] = []): Patch {
  const patch: Patch = {}

  for (const [key, value] of Object.entries(next)) {
    if (nested.includes(key)) {
      const before = (current[key] ?? {}) as Patch
      const changed: Patch = {}
      for (const [innerKey, innerValue] of Object.entries((value ?? {}) as Patch)) {
        if (!same(before[innerKey], innerValue))
          changed[innerKey] = innerValue
      }
      if (Object.keys(changed).length > 0)
        patch[key] = changed
      continue
    }

    if (!same(current[key], value))
      patch[key] = value
  }

  return patch
}

/**
 * Has a **replaced** list been touched by this form?
 *
 * A list a patch replaces (`destinations`, `routes`) is all-or-nothing on the wire:
 * sending it writes the sender's whole view, including the entries it has never
 * seen. So the comparison that decides "send it" must be against the list this form
 * was **filled with**, never against live state — live state moving is precisely
 * what another client's save looks like, and a form that treats that as its own
 * edit deletes whatever arrived while it was open. Measured: with the workspace
 * settings page open on `alpha`, a second client added `beta`; saving an unrelated
 * policy toggle on the first page removed `beta` from disk.
 *
 * `filled` absent means the block was never filled, and a list that was never
 * filled must not travel either: it is `[]`, and `[]` on a replaced list is
 * "delete every entry".
 */
export function replacedListEdited(filled: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  if (filled === undefined)
    return false
  return !same(filled, next)
}

/** The wire form of a replaced list, each entry compared by value. */
export function replacedListPatch<T>(filled: readonly unknown[] | undefined, next: readonly T[]): T[] | null {
  return replacedListEdited(filled, next) ? [...next] : null
}

export interface ReplacedListMerge<T> {
  /** The list this form was filled with; absent means it was never filled. */
  filled: readonly T[] | undefined
  /** What the form holds now. */
  draft: readonly T[]
  /** What the panel holds now, which another client may have changed. */
  live: readonly T[]
  /** One entry's identity; entries sharing a key are the same entry. */
  key: (entry: T) => string
}

/**
 * The list to send for a replaced list, or `null` when this form changed nothing.
 *
 * The form's own edits win, an entry it **removed** stays removed, and an entry that
 * appeared while it was open is kept. That last half is the point: a replaced list is
 * all-or-nothing, so sending only the draft writes "the list I saw when I opened this
 * page" and silently deletes a concurrent addition. A three-way merge — what I filled,
 * what I hold, what is there now — keeps both.
 */
export function mergeReplacedList<T>({ filled, draft, live, key }: ReplacedListMerge<T>): T[] | null {
  if (filled === undefined || same(filled, draft))
    return null

  const filledKeys = new Set(filled.map(key))
  // Entries live holds that this form has never seen — added by another client while it was open.
  // They are appended, not merged into, so the form's own order and edits are untouched.
  const arrived = live.filter(entry => !filledKeys.has(key(entry)) && !draft.some(held => key(held) === key(entry)))
  return [...draft, ...arrived]
}

/**
 * Edits to one server entry.
 *
 * Comparing against the *effective* config (defaults already merged) means an
 * untouched field is omitted from the patch, so an inherited default stays
 * inherited instead of being frozen into `servers.config.json`.
 */
export function diffServerConfig(current: ServerConfig, next: Patch): Patch {
  const before = current as unknown as Patch
  // An absent label and an empty one mean the same thing to the UI.
  return diffFields({ ...before, label: before.label ?? '' }, next, NESTED_GROUPS)
}

export interface FieldChange {
  path: string
  from: unknown
  to: unknown
}

/** Flattens `{ a: { b: 1 } }` into `[{ path: 'a.b', value: 1 }]`. */
export function flattenLeaves(value: unknown, prefix = ''): Array<{ path: string, value: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return [{ path: prefix, value }]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, inner]) => flattenLeaves(inner, prefix.length === 0 ? key : `${prefix}.${key}`))
}

/**
 * The pending patch as a readable list: what each changed leaf was, and what it
 * is about to become. Values a snapshot does not have show as "unset".
 */
export function describeChanges(patch: Patch, current: Patch): FieldChange[] {
  const before = new Map(flattenLeaves(current).map(entry => [entry.path, entry.value]))
  return flattenLeaves(patch).map(entry => ({
    path: entry.path,
    from: before.get(entry.path),
    to: entry.value,
  }))
}

/** Leaf count of a patch, for the "N fields changed" summary. */
export function countLeaves(patch: Patch): number {
  let total = 0
  for (const value of Object.values(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      total += countLeaves(value as Patch)
    else total += 1
  }
  return total
}
