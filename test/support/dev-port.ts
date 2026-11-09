import net from 'node:net'

/**
 * A free control port in a dev range (6xxx), never handed out twice by the same allocator.
 *
 * The CLI suites used to pin ports like 6398/6497/6498 literally, while every sibling CLI suite probed
 * for a free one. Two tests both wanted 6498, and any process already holding it — another test run,
 * a stray panel — made them fail for a reason that names nothing. The port preflight also runs before
 * the config guard, so a busy literal port turns a real assertion red under someone else's process.
 *
 * The `taken` set matters: a probe closes its socket before returning, so the next call can select
 * the very port a still-shutting-down panel is about to rebind. A used port is skipped, not re-probed.
 *
 * Each test file takes its **own** range: files run in parallel, and two files probing one range can
 * both pick a port in the instant between one's probe closing and its panel binding.
 */
export function devPortAllocator(from: number, to: number): () => Promise<number> {
  const taken = new Set<number>()
  return () => new Promise((resolve, reject) => {
    const attempt = (port: number): void => {
      if (port > to) {
        reject(new Error(`no free port in ${from}-${to}`))
        return
      }
      if (taken.has(port)) {
        attempt(port + 1)
        return
      }
      const probe = net.createServer()
      probe.once('error', () => attempt(port + 1))
      probe.listen(port, '127.0.0.1', () => probe.close(() => {
        taken.add(port)
        resolve(port)
      }))
    }
    attempt(from)
  })
}
