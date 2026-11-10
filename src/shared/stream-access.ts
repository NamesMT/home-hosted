import type { SessionView } from './contracts'
import { AuthRequiredError, LocalOnlyError } from './api-client'

/**
 * What a UI does once the browser has given up on an event stream.
 *
 * `EventSource` reports only "it failed", never the status. The panel ends a stream whose credential
 * stopped being valid (a sign-out, a password change), and the browser's retry then meets a 401 and
 * gives up — so the UI has to find out why. A signed-out session goes to the login view. A 401 that
 * signing in cannot fix (`LocalOnlyError`: no password in force and this caller is not the panel's
 * machine) ends the retries with the panel's message instead of reconnecting forever. Anything else
 * — the panel restarting, a dropped network — reconnects.
 */
export type StreamRecovery = { action: 'retry' } | { action: 'login' } | { action: 'refused', message: string }

export async function streamRecovery(fetchSession: () => Promise<SessionView>, probe: () => Promise<unknown>): Promise<StreamRecovery> {
  let session: SessionView
  try {
    session = await fetchSession()
  }
  catch {
    // Unreachable: keep retrying.
    return { action: 'retry' }
  }
  if (session.authRequired && !session.authenticated)
    return { action: 'login' }
  try {
    await probe()
  }
  catch (error) {
    if (error instanceof AuthRequiredError)
      return { action: 'login' }
    if (error instanceof LocalOnlyError)
      return { action: 'refused', message: error.message }
  }
  return { action: 'retry' }
}
