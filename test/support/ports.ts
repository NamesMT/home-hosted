import net from 'node:net'
import process from 'node:process'

/**
 * Ports for tests that start real listeners — panels, fixtures, stand-in servers.
 *
 * Two races made the process-heavy suites flaky under a full parallel run, both from "find a port
 * that is free *now*, release it, and use it later":
 *
 * - `listen(0)` then `close()` hands back an **ephemeral** port, and once it is closed the OS gives
 *   that same port to the next `listen(0)` anywhere on the machine. Fifteen workers open fixtures on
 *   ephemeral ports all run long, so a "port nothing else is holding" was regularly someone else's
 *   — and `down`, probing it, correctly refused.
 * - A fixed per-file range is still a check-then-use race against every other file that guessed the
 *   same range.
 *
 * Each vitest worker gets its own block, below every OS's ephemeral range (Linux starts at 32768,
 * macOS and Windows at 49152), so no `listen(0)` can land on it and no other worker shares it. A
 * worker runs one file at a time, so within the block a counter is enough; each candidate is still
 * probed, so a port a crashed earlier run left behind is skipped rather than reused.
 */
const BASE = 20_000
const BLOCK = 400
// 30 blocks end at 32000, under Linux's ephemeral floor; a larger pool wraps rather than crossing it.
const worker = ((Math.max(1, Number.parseInt(process.env.VITEST_POOL_ID ?? '1', 10) || 1) - 1) % 30) + 1
const start = BASE + (worker - 1) * BLOCK
let next = start

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** A port no other test is using, owned by this worker for the rest of the run. */
export async function testPort(): Promise<number> {
  for (let tried = 0; tried < BLOCK; tried++) {
    const port = next
    next = next + 1 >= start + BLOCK ? start : next + 1
    if (await isFree(port))
      return port
  }
  throw new Error(`no free port left in this worker's block ${start}-${start + BLOCK - 1}`)
}
