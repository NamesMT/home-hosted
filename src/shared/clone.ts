import { isRecord } from './shape'

/**
 * A deep copy that unwraps a reactive proxy at **every** level.
 *
 * `structuredClone(toRaw(value))` looks detached and is not: reading a reactive array hands back
 * proxies for its members, so a list a form rebuilt (`domains = domains.filter(...)`) stores
 * proxies **inside** the raw array. `toRaw` on the parent then unwraps nothing below it, and the
 * clone throws `DataCloneError: #<Object> could not be cloned` — measured on the DDNS form, where
 * removing one hostname left every later edit unable to publish a patch.
 *
 * Rebuilding every object is what removes the proxies, so no `toRaw` is needed here and this module
 * stays Vue-free. Config data is JSON: a `Date` is copied, and any other non-plain value is handed
 * back by reference rather than silently flattened into `{}`.
 */
export function clonePlain<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(entry => walk(entry))
  if (value instanceof Date)
    return new Date(value.getTime())
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value))
      copy[key] = walk(member)
    return copy
  }
  return value
}
