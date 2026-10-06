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

/** Unknown ids are 404; a server that exists but cannot act is a 409. */
export function statusForAction(result: ActionResult): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result[UNKNOWN_SERVER] === true ? 404 : 409
}
