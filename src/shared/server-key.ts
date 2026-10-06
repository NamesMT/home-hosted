/**
 * The SSE bucket key: one server inside one workspace.
 *
 * A server id is only unique within its workspace, so anything keyed by id alone mixes frames between
 * same-named servers — and this key was **three separate definitions**: `services/events.ts` (which
 * dispatches) and both UIs' composables (which subscribe). Byte-identical today, but a change to the
 * format on either side would route messages to the wrong bucket or to none, silently — the panel
 * would simply stop updating, with nothing to error on.
 *
 * It lives in `src/shared` rather than a UI because this module imports no Vue and is reachable from
 * the server and both UIs alike.
 */
export function serverKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}/${serverId}`
}
