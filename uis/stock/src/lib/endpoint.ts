/** Waits for a just-moved endpoint to answer, so a redirect does not race it. */
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
