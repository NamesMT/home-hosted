/** What a per-server action (`start`/`stop`/`restart`/`free-port`) answers with. */
export interface ActionResult {
  ok: boolean
  error?: string
}

/** Unknown ids are 404; a server that exists but cannot act is a 409. */
export function statusForAction(result: ActionResult): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result.error?.startsWith('unknown server') ? 404 : 409
}
