/**
 * Waits for a just-moved endpoint to answer, so a redirect does not race the rebind.
 *
 * Byte-identical in both UIs and importing nothing, so it belongs here: the listener can move to a
 * different host and port, and the browser will follow to a socket that is not accepting yet. Polling
 * `/api/auth/session` (which needs no session) is what makes the wait meaningful rather than a sleep.
 */
export async function waitForEndpoint(url: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${url}/api/auth/session`, { cache: 'no-store' })
      if (response.ok)
        return true
    }
    catch {
      // Not up yet.
    }
    if (Date.now() > deadline)
      return false
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
