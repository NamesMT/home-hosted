import { DetailedError } from '@namesmt/utils'

/** The internal marker. A symbol so it never survives `JSON.stringify`. */
export const UNKNOWN_SERVER: unique symbol = Symbol('hh.unknownServer')

/** What a per-server action (`start`/`stop`/`restart`/`free-port`) answers with. */
export interface ActionResult {
  ok: boolean
  error?: string
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
export function missingServer(id: string): ActionResult {
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
 * The stable code for a failed action, so a script can branch on it rather than on English.
 *
 * The lifecycle routes answered a bare `{ok, error}` while every other route answered the
 * `{message, code, detail}` envelope — on exactly the routes a deploy script calls most, so
 * the README's "a stable `code` a tool can branch on" held everywhere except here. `code` is
 * added rather than replacing `ok`/`error`: an older UI reads those and ignores what it does
 * not know, and a newer panel answering an older client must not change shape underneath it.
 *
 * Two values, not one per message: a missing id is the case a caller must fix, and everything
 * else ("disabled", "stopping", "port in use") is the entry refusing right now. Inventing a
 * code per sentence would be a second copy of the messages. A **success has no code**: a code
 * exists to describe a failure, and stamping one on success answered `ok: true, code:
 * ACTION_FAILED`.
 */
export function actionCode(result: ActionResult): string {
  return result[UNKNOWN_SERVER] === true ? 'UNKNOWN_SERVER' : 'ACTION_FAILED'
}

/**
 * What a lifecycle route puts on the wire: the result it already had, plus its stable code.
 *
 * A **success does not carry a code at all.** Stamping one on it was the first version of this
 * function, and it answered `{"ok":true,"code":"ACTION_FAILED"}` for a start that worked — a code
 * that exists to describe a failure, printed on a success. `code` is added only when there is a
 * failure to name.
 */
export function actionAnswer(result: ActionResult): ActionResult & { code?: string } {
  return result.ok ? { ...result } : { ...result, code: actionCode(result) }
}

/** Unknown ids are 404; a server that exists but cannot act is a 409. */
export function statusForAction(result: ActionResult): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result[UNKNOWN_SERVER] === true ? 404 : 409
}
