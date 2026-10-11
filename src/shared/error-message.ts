/**
 * One rendering for a thrown value, so a caught error reads the same everywhere.
 *
 * `catch` binds `unknown`, and the same ternary was written out in ~60 places across the
 * panel and both UIs. Two idioms in one codebase is how they drift, and the UIs are
 * separate bundles: a fix applied to one copy silently misses the others.
 */
export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}
