export interface BackoffOptions {
  baseDelayMs: number
  factor: number
  maxDelayMs: number
}

/** Exponential backoff: base * factor^(attempt - 1), capped at maxDelayMs. */
export function computeBackoff(attempt: number, options: BackoffOptions): number {
  const normalized = Math.max(1, Math.floor(attempt))
  const raw = options.baseDelayMs * options.factor ** (normalized - 1)
  if (!Number.isFinite(raw))
    return options.maxDelayMs
  return Math.min(Math.max(0, raw), options.maxDelayMs)
}
