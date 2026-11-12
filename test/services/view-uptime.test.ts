import type { Entry } from '#src/services/supervisor/entry'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { HistoryStore } from '#src/services/history'
import { buildView } from '#src/services/supervisor/view'

/**
 * A run counts toward uptime whoever started it.
 *
 * The in-flight interval was added only when `entry.child` was set — a child this panel spawned. A
 * persistent entry reattached to its nanny, or a process adopted after a panel restart, has no child
 * handle: its card and `hh_server_uptime_ratio_24h` read `0` for as long as it served.
 */
function liveEntry(startedAt: number, adopted: boolean): Entry {
  return {
    config: { id: 'web', bind: 'local', port: 8080, restart: { maxRetries: 3 } },
    status: 'running',
    health: 'unknown',
    portState: 'in-use',
    child: adopted ? null : {},
    pid: 4242,
    adopted,
    stoppedByPanel: false,
    startedAt,
    exitCode: null,
    exitSignal: null,
    restarts: 0,
    lastError: null,
    nextRetryAt: null,
    unhealthySince: null,
    logs: { size: 0 },
    responseMs: null,
    resources: null,
    historyCache: null,
  } as unknown as Entry
}

describe('uptime of a run the panel did not spawn', () => {
  it('counts an adopted or reattached run the same as a spawned one', () => {
    const history = new HistoryStore(path.join(os.tmpdir(), `hh-view-uptime-${process.pid}.json`))
    // `load()` reads nothing from a path that does not exist; nothing here is saved.
    const startedAt = Date.now() - 60 * 60 * 1000
    history.record('web', { type: 'start', detail: 'started' }, startedAt)

    const spawned = buildView(liveEntry(startedAt, false), 'default', history).history.uptimeRatio
    const adopted = buildView(liveEntry(startedAt, true), 'default', history).history.uptimeRatio
    expect(spawned).toBeGreaterThan(0.99)
    expect(adopted, 'a reattached run must not read 0% up').toBeGreaterThan(0.99)
  })
})
