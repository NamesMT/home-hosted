import type { ServerConfig } from './contracts'

/** Groups whose patch form is merged into the file rather than replacing it. */
const NESTED_GROUPS = ['restart', 'health', 'stop'] as const

export type Patch = Record<string, unknown>

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Keeps only the fields that differ from `current`.
 *
 * Nested groups list only the sub-keys that changed, which is what lets the
 * server merge a partial patch instead of replacing the whole group.
 */
export function diffFields(current: Patch, next: Patch, nested: readonly string[] = []): Patch {
  const patch: Patch = {}

  for (const [key, value] of Object.entries(next)) {
    if (nested.includes(key)) {
      const before = (current[key] ?? {}) as Patch
      const changed: Patch = {}
      for (const [innerKey, innerValue] of Object.entries((value ?? {}) as Patch)) {
        if (before[innerKey] !== innerValue)
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
