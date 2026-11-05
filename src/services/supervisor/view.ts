import type { HistoryStore } from '#src/services/history'
import type { Entry } from '#src/services/supervisor/entry'
import type { ServerView } from '#src/shared/contracts'
import { bindHost, displayHost } from '#src/helpers/bind'

/** Uptime/crash counters are reported over this window. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const HISTORY_CACHE_MS = 5000

/** Rebuilt when history changes or every few seconds: the view runs per frame and the window math is O(events). */
function summarizeHistory(entry: Entry, history: HistoryStore): ServerView['history'] {
  const now = Date.now()
  const revision = history.revision
  const cached = entry.historyCache
  if (cached !== null && cached.revision === revision && now - cached.at < HISTORY_CACHE_MS)
    return cached.summary

  const runningSince = entry.child !== null && entry.startedAt !== null ? entry.startedAt : null
  const summary = history.summarize(entry.config.id, HISTORY_WINDOW_MS, now, runningSince)
  entry.historyCache = { revision, at: now, summary }
  return summary
}

export function buildView(entry: Entry, workspaceId: string, history: HistoryStore): ServerView {
  const config = entry.config
  const host = displayHost(config.bind)
  return {
    id: config.id,
    workspaceId,
    config,
    bindHost: bindHost(config.bind),
    url: config.port === undefined || config.port === null ? null : `http://${host}:${config.port}`,
    status: entry.status,
    health: entry.health,
    portState: entry.portState,
    pid: entry.pid,
    // Omitted when false: an optional ArkType property rejects an explicit undefined.
    ...(entry.adopted ? { adopted: true } : {}),
    ...(entry.stoppedByPanel ? { stoppedByPanel: true } : {}),
    startedAt: entry.startedAt,
    exitCode: entry.exitCode,
    exitSignal: entry.exitSignal,
    restarts: entry.restarts,
    maxRetries: config.restart.maxRetries,
    lastError: entry.lastError,
    nextRetryAt: entry.nextRetryAt,
    unhealthySince: entry.unhealthySince,
    bufferedLines: entry.logs.size,
    history: summarizeHistory(entry, history),
    responseMs: entry.responseMs,
    resources: entry.resources,
  }
}
