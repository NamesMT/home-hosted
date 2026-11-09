import { errorMessage } from './error-message'

/** One action's own result: a form reads the call it made, never a shared "last error". */
export type Outcome<T> = { ok: true, value: T } | { ok: false, error: string }

export interface ActionRun<T> {
  outcome: Outcome<T>
  /** What the action threw, so the caller can tell a lapsed session from a refusal. */
  actionError?: unknown
  /** The re-read of state after a successful action failed; the action itself still succeeded. */
  refetchError?: unknown
}

/**
 * Runs an action, then re-reads state — and reports the two separately.
 *
 * Both UIs did `await action(); await refetch()` inside one `try`, so a state read that failed
 * after a successful save (the panel restarting to rebind, a dropped connection) reported the save
 * as failed: the form stayed open with an error over a change that was already on disk, and a
 * retry wrote it twice. The action's own result is the answer; a failed refetch is the caller's to
 * mention, and the next state frame repairs it.
 */
export async function runThenRefetch<T>(action: () => Promise<T>, refetch: () => Promise<unknown>): Promise<ActionRun<T>> {
  let value: T
  try {
    value = await action()
  }
  catch (error) {
    return { outcome: { ok: false, error: errorMessage(error) }, actionError: error }
  }
  try {
    await refetch()
  }
  catch (error) {
    return { outcome: { ok: true, value }, refetchError: error }
  }
  return { outcome: { ok: true, value } }
}
