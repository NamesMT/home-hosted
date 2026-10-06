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

/** Unknown ids are 404; a server that exists but cannot act is a 409. */
export function statusForAction(result: ActionResult): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result[UNKNOWN_SERVER] === true ? 404 : 409
}
