import { testPort } from './ports'

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
/** Kept for its call sites; every port now comes from the per-worker blocks in `ports.ts`. */
export function devPortAllocator(_from?: number, _to?: number): () => Promise<number> {
  return testPort
}
