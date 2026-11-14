import type { HistoryStore } from '#src/services/history'
import type { Entry } from '#src/services/supervisor/entry'
import type { ServerView } from '#src/shared/contracts'
import { bindHost, displayHost } from '#src/helpers/bind'
import { needsRestart } from '#src/services/supervisor/restart-required'

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

  // Any live run, not only one this panel spawned: a reattached persistent entry or an adopted
  // process has no child handle, and read 0% up for as long as it ran.
  const live = entry.child !== null || (entry.adopted && entry.pid !== null)
  const runningSince = live && entry.startedAt !== null ? entry.startedAt : null
  const summary = history.summarize(entry.config.id, HISTORY_WINDOW_MS, now, runningSince)
  entry.historyCache = { revision, at: now, summary }
  return summary
}

export function buildView(
  entry: Entry,
  workspaceId: string,
  history: HistoryStore,
  /** Which of `config.secretEnv` have a value stored. Names only — the values never leave the store. */
  secretEnvSet: readonly string[] = [],
): ServerView {
  const config = entry.config
  const restartRequired = needsRestart(config, entry.startedFrom)
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
    // Omitted when false, like every other optional flag on the view.
    ...(restartRequired ? { restartRequired: true } : {}),
    // What a deploy is doing, and how the last one went — absent for an entry with no `deploy`.
    ...(config.deploy === undefined || config.deploy === null
      ? {}
      : {
          deploy: {
            running: entry.deploying,
            ...(entry.deployLastAt === null ? {} : { lastAt: entry.deployLastAt }),
            ...(entry.deployLastOutcome === null ? {} : { lastOutcome: entry.deployLastOutcome }),
            ...(entry.deployLastError === null ? {} : { lastError: entry.deployLastError }),
          },
        }),
    // Which declared names are actually set. A name the entry declares but that has no value is
    // simply absent here, which is exactly what the editor needs to show "set" or "not set".
    ...(secretEnvSet.length === 0 ? {} : { secretEnvSet: [...secretEnvSet] }),
  }
}
