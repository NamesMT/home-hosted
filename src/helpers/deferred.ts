/**
 * Runs a task after the current response has been written.
 *
 * Moving the control listener closes the connection serving the request that
 * asked for the move, so those steps must happen once the response is out.
 */
export function afterResponse(task: () => Promise<void>, onError?: (error: unknown) => void): void {
  setImmediate(() => {
    void task().catch((error: unknown) => {
      onError?.(error)
    })
  })
}
