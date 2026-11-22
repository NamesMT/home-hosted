import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What one state frame may touch.
 *
 * The frame is built on every tick (1/s) and on every `GET /api/state`, and it is fanned out over SSE
 * to every tab, so anything it does happens up to once a second per open client. That is fine as long
 * as it does no filesystem work — and it is a filesystem load the moment it does. This has already
 * gone wrong once: `backup-frame-cost.test.ts` records `getState()` reading every workspace's
 * `.secrets.json` and stat'ing every archive, **396 reads in 8 s**, 0.52 s of that window inside them.
 *
 * **Why this scans call sites instead of timing.** A first version of this file built 50 frames at
 * eight workspaces × six servers and asserted wall time. Measured: 0.77 ms/frame. Then every frame was
 * made to read a real config file — **0.86 ms/frame**, and the test stayed green. The reads were
 * page-cached, so a per-frame `readFileSync` costs microseconds and no timer can see it; the damage is
 * in syscalls and in what happens on a cold cache or a network mount, not in elapsed time. A budget on
 * milliseconds is therefore the wrong instrument for this defect, which is exactly what
 * `backup-frame-cost.test.ts` concluded before and solved by reading the function bodies.
 *
 * So: the frame path (and the views it builds) must not name a filesystem read. The views it calls
 * are allowed to be **cached** — `tls.status()` and `ui.status()` reuse an answer for a few seconds —
 * and that caching is what this pins, by requiring the cache next to the read.
 */
const root = path.resolve(import.meta.dirname, '..', '..')

/** The file's text, with CRLF normalised: a Windows checkout would otherwise break the boundaries. */
function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n')
}

/** The body of one top-level function or class method, by brace depth from its opening `{`. */
function bodyOf(text: string, name: string): string {
  const asFunction = text.indexOf(`function ${name}(`)
  const asMethod = text.search(new RegExp(`^  (?:private |public |protected |async )*${name}\\(`, 'm'))
  const at = asFunction === -1 ? asMethod : asFunction
  expect(at, `${name} not found — the scan is stale`).toBeGreaterThan(-1)

  const rest = text.slice(at)
  const open = rest.indexOf('{')
  let depth = 0
  for (let index = open; index < rest.length; index += 1) {
    if (rest[index] === '{') {
      depth += 1
    }
    else if (rest[index] === '}') {
      depth -= 1
      if (depth === 0)
        return rest.slice(open, index + 1)
    }
  }
  return rest.slice(open)
}

/** Every filesystem call that can hit the disk from a synchronous path. */
const DISK_READ = /\b(readFileSync|readdirSync|statSync|existsSync|readFile|readdir|stat)\s*\(/

/**
 * A **process spawn** on the frame path, which `DISK_READ` does not cover and `AGENTS.md` forbids in the
 * same sentence: *"never call `execFileSync` from a request or frame path"*.
 *
 * The synchronous form is the one that matters — it blocks the event loop for the whole spawn, and the
 * frame runs about once a second. `execFile`/`spawn` are excluded on purpose: they are asynchronous and
 * are how this codebase legitimately starts things.
 *
 * The rule holds today: `src/providers/host.ts` does call `execFileSync('vm_stat')` and
 * `execFileSync('getconf')`, but behind `availableMemoryBytes(platform, osFree, vmStat?)`, which takes the
 * sample as an argument — the syscall fires only when no sample was supplied, i.e. on the sampler's own
 * clock, never on the frame's. That shape is what this assertion protects.
 */
const SPAWN_SYNC = /\b(execFileSync|execSync|spawnSync)\s*\(/

describe('the state frame does no filesystem work', () => {
  /**
   * The three functions that run per frame, in `panel.ts`.
   *
   * `stateSignature` is included because it serialises the whole frame — a change that makes the view
   * cheap but the signature expensive is no improvement, and the signature runs on the same clock.
   */
  it('getState, publishState and stateSignature neither read the disk nor spawn', () => {
    const text = source('src/services/panel.ts')
    for (const name of ['getState', 'publishState', 'stateSignature']) {
      const body = bodyOf(text, name)
      expect(body, `${name} must not read the disk`).not.toMatch(DISK_READ)
      expect(body, `${name} must not spawn a process synchronously — it blocks the whole frame`).not.toMatch(SPAWN_SYNC)
    }
  })

  /**
   * The two views the frame consumes that could read a file every time.
   *
   * Both *do* read the disk — a certificate pair, an installed `ui.json` — and that is legitimate once
   * in a while. What must not happen is reading it per frame, so each is required to carry the cache
   * that makes the per-frame call free. A version without the cache is the defect: `tls.status()`
   * parses a certificate and compares keys, about 1.6 ms, sixty times a minute.
   */
  it('the TLS and UI statuses the frame reads are cached', () => {
    const tls = source('src/services/tls.ts')
    const status = bodyOf(tls, 'status')
    expect(status, 'tls.status() must reuse a recent answer').toMatch(/statusCache|cache/)

    const ui = source('src/services/ui.ts')
    const uiStatus = bodyOf(ui, 'status')
    expect(uiStatus, 'ui.status() must reuse a recent answer').toMatch(/statusCache|cache/)
  })

  /**
   * Anti-vacuity: the scan has to be looking at code that really exists and really reads.
   *
   * Without this, a rename in `backups.ts` would leave the two assertions above matching empty bodies
   * and passing — the failure mode a source scan is most prone to.
   */
  it('the scan sees real bodies, and the disk read it forbids does occur elsewhere', () => {
    // `view()` is the per-frame one: it must be policy only. Its cost test already lives in
    // `backup-frame-cost.test.ts`, so this only proves the scan resolves a real body.
    const view = bodyOf(source('src/services/backups.ts'), 'view')
    expect(view.length, 'view() resolved to nothing — the scan is stale').toBeGreaterThan(50)
    expect(view, 'the per-frame view must stay policy-only').not.toMatch(DISK_READ)

    // And the disk read the assertion above forbids really is in the same file, so the pattern is not
    // looking for something that never occurs.
    expect(source('src/services/backups.ts'), 'the read this test forbids must exist somewhere').toMatch(DISK_READ)
  })
})
