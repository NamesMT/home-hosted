import { isRecord } from '#src/shared/shape'
/** Nested groups a patch merges into instead of replacing. */
export const SERVER_MERGE_KEYS = new Set(['restart', 'health', 'stop'])
export const CONTROL_MERGE_KEYS = new Set(['auth', 'tls'])
export const NOTIFICATION_MERGE_KEYS = new Set(['telegram'])
/** The DDNS lists are replaced; only its two IP-family groups merge. */
export const DDNS_MERGE_KEYS = new Set(['ipv4', 'ipv6'])
/** The proxy's one nested group; `routes` and `certificates` are lists a patch replaces. */
export const PROXY_MERGE_KEYS = new Set(['dns01'])
export const EMPTY_MERGE_KEYS = new Set<string>()

export function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>, mergeKeys: Set<string>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      continue
    if (mergeKeys.has(key) && isRecord(value) && isRecord(target[key])) {
      target[key] = mergeGroup(target[key], value)
      continue
    }
    // An explicit `null` **removes** the key, exactly as it does inside a group. Setting it instead made the
    // two paths disagree, and the stored `null` then failed the schema that reads the file:
    // `servers[0]: label must be a string (was null)`. This was reachable all along — `label` is not in
    // `SERVER_MERGE_KEYS`, so it took this branch.
    if (value === null) {
      delete target[key]
      continue
    }
    target[key] = value
  }
}

/**
 * Merges one nested group recursively — `health.http` is a group of its own, and
 * replacing it wholesale would silently reset the siblings a partial patch never
 * mentioned. An explicit `null` removes a key, which is how a schema-optional
 * field is cleared.
 */
export function mergeGroup(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      continue
    if (value === null) {
      delete merged[key]
      continue
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeGroup(merged[key] as Record<string, unknown>, value)
      continue
    }
    merged[key] = value
  }
  return merged
}
