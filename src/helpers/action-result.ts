import { DetailedError } from '@namesmt/utils'

/** The internal marker. A symbol so it never survives `JSON.stringify`. */
export const UNKNOWN_SERVER: unique symbol = Symbol('hh.unknownServer')

/**
 * Why a lifecycle action was refused, as a kind rather than a sentence.
 *
 * The wire code is derived from this, so a client branches on the reason instead of matching English
 * — and nothing has to read a message back to decide what it was. `unknown` is the honest answer for
 * a refusal no rule here classifies; it becomes `ACTION_FAILED`.
 */
export type ActionReason = 'disabled' | 'busy' | 'port-in-use' | 'dependency-failed'

/** What a per-server action (`start`/`stop`/`restart`/`free-port`) answers with. */
export interface ActionOutcome {
  ok: boolean
  error?: string
  /** A stop that succeeded: the entries still running that declare `dependsOn` this one. */
  dependents?: string[]
  /**
   * The refusal's kind, when the supervisor knows it. Internal: it picks the wire `code` and never
   * reaches a client as itself, so the body keeps the shape older clients already read.
   */
  reason?: ActionReason
  /**
   * Set when the failure was "no such entry" rather than "this entry cannot act".
   *
   * The status rule needs the *kind* of failure, and a message is not a kind: any text beginning
   * `unknown server` — a future "unknown serverless runtime" — was read as a missing id, telling the
   * client to fix an id that was fine.
   *
   * A **symbol**, so it is internal: it carries the meaning to `statusForAction` without joining the
   * JSON a client receives, which would be an unintended wire change. `missingServer()` is the only
   * writer.
   */
  [UNKNOWN_SERVER]?: true
}

/** The one shape a missing entry takes, so the marker and the message cannot drift apart. */
export function missingServer(id: string): ActionOutcome {
  return { ok: false, error: `unknown server "${id}"`, [UNKNOWN_SERVER]: true }
}

/**
 * The same failure where the caller throws instead of answering — the route side of `missingServer()`.
 *
 * `api/logs.ts` and `api/servers/$.routes.ts` each carried a byte-identical private copy of this, with
 * six call sites between them. Two copies of a wire contract (the message, the 404, the `UNKNOWN_SERVER`
 * code) is the drift that already happened once for `request`: a change landing in one UI and not the
 * other. Defining it beside the message keeps one owner for the wording.
 */
export function unknownServerError(id: string): DetailedError {
  return new DetailedError(`unknown server "${id}"`, { statusCode: 404, code: 'UNKNOWN_SERVER' })
}

/**
 * The stable code for a failed action, so a script branches on it rather than on English.
 *
 * A missing id is what the caller must fix; a refusal says *which* refusal, because "disabled",
 * "still stopping", "the port is taken" and "a dependency did not come up" are four different
 * fixes. They all shared one `ACTION_FAILED`, so a client had to match the English to tell them
 * apart — which is the thing a code exists to avoid. `code` is added beside `ok`/`error` rather than
 * replacing them, because an older UI reads those.
 */
export function actionCode(result: ActionOutcome): string {
  if (result[UNKNOWN_SERVER] === true)
    return 'UNKNOWN_SERVER'
  switch (result.reason) {
    case 'disabled': return 'SERVER_DISABLED'
    case 'busy': return 'SERVER_BUSY'
    case 'port-in-use': return 'PORT_IN_USE'
    case 'dependency-failed': return 'DEPENDENCY_FAILED'
    default: return 'ACTION_FAILED'
  }
}

/** What a lifecycle route puts on the wire. A success carries no code — a code names a failure. */
export function actionAnswer(result: ActionOutcome): ActionOutcome & { code?: string, message?: string } {
  // A refusal carries the same `message`/`code` as every other failure; `ok`/`error` stay for older
  // clients, and `reason` is stripped — it selected the code, it is not part of the contract.
  if (result.ok)
    return { ...result }
  const { reason: _reason, ...rest } = result
  return { ...rest, message: result.error ?? 'the action failed', code: actionCode(result) }
}

/** Unknown ids are 404; a server that exists but cannot act is a 409. */
export function statusForAction(result: ActionOutcome): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result[UNKNOWN_SERVER] === true ? 404 : 409
}
