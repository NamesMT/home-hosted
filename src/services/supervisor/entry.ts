import type { ChildProcess } from 'node:child_process'
import type { ComposeTarget } from '#src/providers/docker'
import type { SpawnInfo } from '#src/providers/identity'
import type { ControlEndpoint } from '#src/services/control-server'
import type { HistoryStore } from '#src/services/history'
import type { LogFiles } from '#src/services/log-files'
import type { NotificationReason, NotificationService } from '#src/services/notifications'
import type { HealthState, HistoryActor, LogStream, NannyExit, PortState, ProcessResources, ServerConfig, ServerStatus, ServerView } from '#src/shared/contracts'
import { entryStatePath, readEntryState } from '#src/providers/entry-state'
import { LogBuffer } from '#src/services/log-buffer'

export interface SupervisorOptions {
  /** The workspace this supervisor supervises; every view is tagged with it. */
  workspaceId: string
  configPath: string
  /** Live listener info, mutated by the control server when it rebinds. */
  control: ControlEndpoint
  history: HistoryStore
  logFiles: LogFiles
  notifications: NotificationService
  /** Signals a state change; the panel owns and publishes the aggregate frame. */
  onStateChange: () => void
  /** Where a persistent entry's nanny keeps its state. */
  nannyDir: string
  /**
   * The *other* workspaces' running servers, so a port they hold is recognized as the panel's own.
   * The pair travels with the pid because a refusal has to say **where** the holder lives. A lone
   * supervisor (a unit harness) has no siblings.
   */
  siblingServers?: () => Promise<SiblingServer[]>
}

export interface StartResult {
  ok: boolean
  error?: string
}

/** One running server in another workspace: the identity a cross-workspace refusal has to name. */
export interface SiblingServer {
  pid: number
  workspaceId: string
  serverId: string
}

/**
 * Everything a start needs, resolved once. `loggedArgs` is the argv *before* `${VAR}` expansion, so
 * a secret in an argument never reaches the log; `args` is what is spawned.
 */
export interface ResolvedSpawn extends SpawnInfo {
  env: Record<string, string>
  loggedArgs: string[]
}

export interface Entry {
  config: ServerConfig
  status: ServerStatus
  health: HealthState
  portState: PortState
  child: ChildProcess | null
  pid: number | null
  startedAt: number | null
  /**
   * The last non-persistent child this panel spawned — the only trace of a detached child that
   * outlived a panel killed hard. Always null for a persistent entry: its nanny's state file is the record.
   */
  lastChild: { pid: number, startedAt: number } | null
  exitCode: number | null
  exitSignal: string | null
  restarts: number
  /** Force restarts spent on the current unhealthy sequence, bounded by `restart.maxRetries`. */
  healthRestarts: number
  lastError: string | null
  nextRetryAt: number | null
  retryTimer: NodeJS.Timeout | null
  healthFailures: number
  unhealthySince: number | null
  /**
   * A force restart whose outcome is still owed, with its cause. Remembered rather than inferred from
   * `health`, because the restart resets health and the `unhealthy -> healthy` transition never happens.
   */
  pendingRestart: { cause: string } | null
  lastProbeAt: number
  lastOccupancyProbeAt: number
  probing: boolean
  /** The running process is a detached successor we adopted, not a child we spawned. */
  adopted: boolean
  /** The panel stopped this entry because it could not serve — not the operator. */
  stoppedByPanel: boolean
  /** How a persistent entry's child ended, read from its nanny's state file. */
  nannyExit: NannyExit | null
  /** A start is in flight (set synchronously, unlike `status`). */
  starting: boolean
  stopping: boolean
  /**
   * Bumped by every stop and by the end of every run, so a start or a probe that awaited across one
   * can tell its work no longer belongs to the entry.
   */
  runToken: number
  /** The start in flight, which a stop waits out once it has cancelled it. */
  startTask: Promise<StartResult> | null
  /**
   * The stop in flight. Two stops on one entry join this instead of each running a tail — a second
   * tail would clear `stopping` mid-teardown and publish `stopped` over a start it never saw.
   */
  stopTask: Promise<StartResult> | null
  bootstrapChild: ChildProcess | null
  /** Who asked for the start in flight, recorded on its history event. */
  actor: HistoryActor
  /** The config dropped this entry: the stop that follows must not recreate its reclaimed logs or history. */
  removed: boolean
  bootstrapDone: boolean
  /** A staged dump this entry still has to load, run once its process is answering. */
  pendingLoad: string | null
  /** A load is running right now, so a second `start` must not run it again. */
  loadingPending: boolean
  logs: LogBuffer
  /** Lines this panel wrote into a persistent entry's log file, so the relay does not push them twice. */
  echoed: Set<string>
  responseMs: number | null
  resources: ProcessResources | null
  /** Whether `resources` is the summed containers (a compose entry) rather than the wrapper's tree. */
  resourcesFromContainers: boolean
  resourcesSampledAt: number
  /** The compose project this entry runs, detected once at start; `null` means "sample the process tree". */
  compose: ComposeTarget | null
  historyCache: { revision: number, at: number, summary: ServerView['history'] } | null
}

/** What the extracted modules need from the supervisor that owns an entry. */
export interface SupervisorContext {
  readonly options: SupervisorOptions
  log: (entry: Entry, stream: LogStream, text: string) => void
  publishServer: (entry: Entry) => void
  persist: (entry: Entry) => void
  notify: (entry: Entry, reason: NotificationReason, detail: string) => void
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createEntry(config: ServerConfig, nannyDir: string): Entry {
  // The retry budget, the bootstrap flag and the last child must outlive the panel: in memory alone a
  // crash loop got a fresh budget on every boot, and a detached child that survived became a twin.
  const persisted = readEntryState(entryStatePath(nannyDir, config.id))
  const lastPid = persisted?.lastPid ?? null
  return {
    config,
    status: 'stopped',
    health: config.health.enabled ? 'unknown' : 'disabled',
    portState: 'unknown',
    child: null,
    pid: null,
    startedAt: null,
    lastChild: !config.persistent && lastPid !== null ? { pid: lastPid, startedAt: persisted?.lastStartedAt ?? 0 } : null,
    exitCode: null,
    exitSignal: null,
    restarts: persisted?.restarts ?? 0,
    healthRestarts: persisted?.healthRestarts ?? 0,
    lastError: null,
    nextRetryAt: null,
    retryTimer: null,
    healthFailures: 0,
    unhealthySince: null,
    pendingRestart: null,
    lastProbeAt: 0,
    lastOccupancyProbeAt: 0,
    probing: false,
    adopted: false,
    stoppedByPanel: false,
    nannyExit: null,
    starting: false,
    stopping: false,
    runToken: 0,
    startTask: null,
    stopTask: null,
    bootstrapChild: null,
    actor: 'policy',
    removed: false,
    bootstrapDone: persisted?.bootstrapDone ?? !config.bootstrap,
    pendingLoad: persisted?.pendingLoad ?? null,
    loadingPending: false,
    logs: new LogBuffer(config.logBufferLines),
    echoed: new Set(),
    responseMs: null,
    resources: null,
    resourcesFromContainers: false,
    resourcesSampledAt: 0,
    compose: null,
    historyCache: null,
  }
}

export function isActive(entry: Entry): boolean {
  // An adopted successor has no child of ours but is running; disabling it must still stop it.
  return entry.child !== null || entry.pid !== null || entry.adopted || entry.status === 'backoff'
}
