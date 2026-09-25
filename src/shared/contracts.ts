import { type } from 'arktype'

/**
 * Schemas shared by the control plane and the SPA: the server entry shape, the
 * control panel's own settings, API DTOs and SSE frames. Nothing here knows
 * about a particular server — an entry carries its own command, args, env and
 * bootstrap.
 */

/** `local` -> 127.0.0.1, `lan` -> 0.0.0.0, or an explicit IPv4 to bind. */
export const bindSchema = type('"local" | "lan" | /^\\d{1,3}(?:\\.\\d{1,3}){3}$/')
export type Bind = typeof bindSchema.infer

/** Parses a bind value (`local` | `lan` | ipv4); null when it is not one. */
export function parseBind(value: string): Bind | null {
  const parsed = bindSchema(value)
  return parsed instanceof type.errors ? null : parsed
}

/** `null` means "no port": no readiness probe, no health supervision, no preflight. */
export const portSchema = type('1 <= number.integer <= 65535 | null')

/**
 * What to do when something already listens on the entry's port. `follow` and
 * `reclaim` only ever act on a holder proven to be this entry's own detached
 * successor (the `HHOSTED_SERVER_ID` marker, POSIX only); `kill` is the blunt one:
 * it stops any holder except the panel's own process tree.
 */
export const onPortConflictSchema = type.enumerated('block', 'warn', 'follow', 'reclaim', 'kill')
export type OnPortConflict = typeof onPortConflictSchema.infer

/** The stored forms carry the default; a patch must not (see the patch schemas below). */
export const onPortConflictDefaultSchema = onPortConflictSchema.default('block')

export const restartSchema = type({
  enabled: 'boolean = true',
  maxRetries: 'number.integer >= 0 = 3',
  baseDelayMs: 'number >= 0 = 1000',
  factor: 'number >= 1 = 2',
  maxDelayMs: 'number >= 0 = 30000',
  /** A process alive this long is considered healthy again and the retry counter resets. */
  resetAfterMs: 'number >= 0 = 60000',
}).onUndeclaredKey('reject')

export type RestartConfig = typeof restartSchema.infer

export const httpCheckSchema = type({
  /** Path on the server's own port, e.g. `/healthz`. */
  path: 'string = "/"',
  method: '"GET" | "HEAD" = "GET"',
  /** Exact status to accept; `null` (or omitted) means any status below `expectStatusBelow`. */
  expectStatus: 'number.integer | null?',
  expectStatusBelow: 'number.integer = 400',
  /** Substring that must appear in the response body. */
  expectBody: 'string = ""',
}).onUndeclaredKey('reject')
export type HttpCheckConfig = typeof httpCheckSchema.infer

/** Restart guards for the process tree. */
export const resourcesSchema = type({
  /** Restart when the tree's RSS exceeds this; 0 disables. */
  maxRssBytes: 'number.integer >= 0 = 0',
}).onUndeclaredKey('reject')
export type ResourcesConfig = typeof resourcesSchema.infer

export const healthSchema = type({
  enabled: 'boolean = true',
  /** `port` = TCP connect only; `http` = fetch `http.path` and assert the response. */
  mode: '"port" | "http" = "port"',
  http: httpCheckSchema.default(() => ({})),
  intervalMs: 'number >= 500 = 5000',
  timeoutMs: 'number >= 100 = 1500',
  /** Consecutive failed probes before the warning state is shown. */
  unhealthyThreshold: 'number.integer >= 1 = 3',
  /** 0 disables it; otherwise a port stuck unhealthy this long forces a restart. */
  forceRestartAfterMs: 'number >= 0 = 0',
  /** How long to wait for the port to accept connections after spawn. */
  startTimeoutMs: 'number >= 0 = 20000',
}).onUndeclaredKey('reject')

export type HealthConfig = typeof healthSchema.infer

export const stopSchema = type({
  signal: '"SIGTERM" | "SIGINT" | "SIGKILL" = "SIGTERM"',
  killGroup: 'boolean = true',
  graceMs: 'number >= 0 = 5000',
  /** Last resort for wrappers that detach their real server. */
  killPortHolders: 'boolean = false',
}).onUndeclaredKey('reject')

export type StopConfig = typeof stopSchema.infer

export const bootstrapSchema = type({
  command: 'string',
  args: type('string[]').default(() => []),
  env: type('Record<string, string>').default(() => ({})),
  timeoutMs: 'number >= 1000 = 120000',
  /** Run once per `up` session; whatever it installs persists on disk. */
  runOnce: 'boolean = true',
}).onUndeclaredKey('reject')
export type BootstrapConfig = typeof bootstrapSchema.infer
export const bootstrapOrNullSchema = bootstrapSchema.or(type('null'))

export const logBufferLinesSchema = type('50 <= number.integer <= 100000')

export const serverSchema = type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  label: 'string?',
  enabled: 'boolean = true',
  autostart: 'boolean = false',
  command: 'string >= 1',
  args: type('string[]').default(() => []),
  cwd: 'string = "."',
  env: type('Record<string, string>').default(() => ({})),
  /**
   * `ENV=path` pairs: exported to the process (overriding `env`) *and* the path
   * is backed up automatically — one declaration for data directories.
   */
  dataEnvs: type('Record<string, string>').default(() => ({})),
  bootstrap: bootstrapOrNullSchema.optional(),
  port: portSchema.optional(),
  bind: bindSchema.default(() => 'local' as const),
  onPortConflict: onPortConflictDefaultSchema,
  restart: restartSchema.default(() => ({})),
  health: healthSchema.default(() => ({})),
  stop: stopSchema.default(() => ({})),
  logBufferLines: logBufferLinesSchema.default(() => 500),
  /** Ids this server needs running first (and healthy); stopped in reverse order. */
  dependsOn: type('string[]').default(() => []),
  /** Optional KEY=value file loaded at spawn; its values override `env`. */
  envFile: 'string = ""',
  resources: resourcesSchema.default(() => ({})),
  /** Paths included in backups for this server (templates allowed). */
  backupPaths: type('string[]').default(() => []),
  /**
   * Skip well-known build output and dependency directories (`node_modules`,
   * `dist`, `.next`, caches, …) inside the paths this entry declares.
   */
  backupIgnoreGenerated: 'boolean = true',
}).onUndeclaredKey('reject')
export type ServerConfig = Omit<typeof serverSchema.infer, 'port'> & { port: number | null }

/**
 * Authentication for the control panel itself. The password never lives here —
 * only the policy does; its scrypt hash sits in a git-ignored secrets file.
 */
export const authSchema = type({
  enabled: 'boolean = true',
  sessionTtlMs: 'number >= 60000 = 604800000',
  /** `auto` adds `Secure` when the request arrived over https (proxy-aware). */
  cookieSecure: '"auto" | "always" | "never" = "auto"',
  /** Trust `x-forwarded-*` from a reverse proxy; also drives the client IP. */
  trustProxy: 'boolean = false',
  maxLoginAttempts: 'number.integer >= 1 = 5',
  lockoutMs: 'number >= 1000 = 60000',
}).onUndeclaredKey('reject')
export type AuthConfig = typeof authSchema.infer

/** Outbound crash/health notifications. The bot token lives in the secrets file. */
export const telegramSchema = type({
  enabled: 'boolean = false',
  chatId: 'string = ""',
  onCrash: 'boolean = true',
  onUnhealthy: 'boolean = true',
  onForcedRestart: 'boolean = true',
  onRecovered: 'boolean = false',
  /** Host vitals breaches (disk, memory, swap, load, temperature). */
  onHost: 'boolean = true',
  /** Per server *and* reason, so a flapping server cannot spam the chat. */
  cooldownMs: 'number >= 0 = 120000',
}).onUndeclaredKey('reject')
export type TelegramConfig = typeof telegramSchema.infer

export const notificationsSchema = type({
  telegram: telegramSchema.default(() => ({})),
}).onUndeclaredKey('reject')
export type NotificationsConfig = typeof notificationsSchema.infer

/** On-disk log retention for the Logs page. */
export const logsSchema = type({
  persist: 'boolean = true',
  /** Per server, before rotating to `.1`, `.2`, ... */
  maxBytes: '10000 <= number <= 100000000 = 2000000',
  keep: '1 <= number.integer <= 10 = 3',
}).onUndeclaredKey('reject')
export type LogsConfig = typeof logsSchema.infer

export const tlsSchema = type({
  enabled: 'boolean = false',
}).onUndeclaredKey('reject')
export type TlsConfig = typeof tlsSchema.infer

/** Host-level vitals and their alert thresholds. */
export const hostSchema = type({
  enabled: 'boolean = true',
  intervalMs: 'number >= 5000 = 15000',
  /** Filesystems reported and alerted on; templates and `~` are expanded. */
  diskPaths: type('string[]').default(() => ['.']),
  /** 0 disables an individual alert. */
  diskUsedPercent: 'number >= 0 = 90',
  memoryUsedPercent: 'number >= 0 = 90',
  swapUsedPercent: 'number >= 0 = 50',
  loadPerCpu: 'number >= 0 = 2',
  tempCelsius: 'number >= 0 = 85',
}).onUndeclaredKey('reject')
export type HostConfig = typeof hostSchema.infer

/** Tar archives of config, secrets, TLS and declared data paths. */
export const backupsSchema = type({
  enabled: 'boolean = true',
  dir: 'string = ".backups"',
  keep: 'number.integer >= 1 = 5',
  /** Extra paths in every backup, in addition to each server's `backupPaths`. */
  includePaths: type('string[]').default(() => []),
}).onUndeclaredKey('reject')
export type BackupsConfig = typeof backupsSchema.infer

export const controlSchema = type({
  /** What the panel calls itself; the stock UI shows it in the sidebar. */
  label: '1 <= string <= 60 = "home-hosted"',
  port: '1 <= number.integer <= 65535 = 3999',
  /** Where the control panel itself listens; keep it `local` unless you mean it. */
  host: bindSchema.default(() => 'local' as const),
  openBrowser: 'boolean = false',
  auth: authSchema.default(() => ({})),
  tls: tlsSchema.default(() => ({})),
}).onUndeclaredKey('reject')
export type ControlConfig = typeof controlSchema.infer

/** Applied to every server entry; whatever an entry sets wins. */
export const defaultsSchema = type({
  enabled: 'boolean = true',
  autostart: 'boolean = false',
  bind: bindSchema.default(() => 'local' as const),
  onPortConflict: onPortConflictDefaultSchema,
  restart: restartSchema.default(() => ({})),
  health: healthSchema.default(() => ({})),
  stop: stopSchema.default(() => ({})),
  logBufferLines: logBufferLinesSchema.default(() => 500),
}).onUndeclaredKey('reject')
export type ServerDefaults = typeof defaultsSchema.infer

// Patch variants stay default-free: an API client sends only what it changes, so
// a partial nested group must not silently pull in the code defaults.
const restartPatchSchema = type({
  enabled: 'boolean?',
  maxRetries: 'number.integer >= 0?',
  baseDelayMs: 'number >= 0?',
  factor: 'number >= 1?',
  maxDelayMs: 'number >= 0?',
  resetAfterMs: 'number >= 0?',
}).onUndeclaredKey('reject')

const httpCheckPatchSchema = type({
  path: 'string?',
  method: '"GET" | "HEAD"?',
  expectStatus: 'number.integer | null?',
  expectStatusBelow: 'number.integer?',
  expectBody: 'string?',
}).onUndeclaredKey('reject')

const resourcesPatchSchema = type({
  maxRssBytes: 'number.integer >= 0?',
}).onUndeclaredKey('reject')

const healthPatchSchema = type({
  enabled: 'boolean?',
  mode: '"port" | "http"?',
  http: httpCheckPatchSchema.optional(),
  intervalMs: 'number >= 500?',
  timeoutMs: 'number >= 100?',
  unhealthyThreshold: 'number.integer >= 1?',
  forceRestartAfterMs: 'number >= 0?',
  startTimeoutMs: 'number >= 0?',
}).onUndeclaredKey('reject')

const stopPatchSchema = type({
  signal: '"SIGTERM" | "SIGINT" | "SIGKILL"?',
  killGroup: 'boolean?',
  graceMs: 'number >= 0?',
  killPortHolders: 'boolean?',
}).onUndeclaredKey('reject')

const authPatchSchema = type({
  enabled: 'boolean?',
  sessionTtlMs: 'number >= 60000?',
  cookieSecure: '"auto" | "always" | "never"?',
  trustProxy: 'boolean?',
  maxLoginAttempts: 'number.integer >= 1?',
  lockoutMs: 'number >= 1000?',
}).onUndeclaredKey('reject')

const telegramPatchSchema = type({
  enabled: 'boolean?',
  chatId: 'string?',
  onCrash: 'boolean?',
  onUnhealthy: 'boolean?',
  onForcedRestart: 'boolean?',
  onRecovered: 'boolean?',
  onHost: 'boolean?',
  cooldownMs: 'number >= 0?',
}).onUndeclaredKey('reject')

const notificationsPatchSchema = type({
  telegram: telegramPatchSchema.optional(),
}).onUndeclaredKey('reject')

const hostPatchSchema = type({
  enabled: 'boolean?',
  intervalMs: 'number >= 5000?',
  diskPaths: type('string[]').optional(),
  diskUsedPercent: 'number >= 0?',
  memoryUsedPercent: 'number >= 0?',
  swapUsedPercent: 'number >= 0?',
  loadPerCpu: 'number >= 0?',
  tempCelsius: 'number >= 0?',
}).onUndeclaredKey('reject')

const backupsPatchSchema = type({
  enabled: 'boolean?',
  dir: 'string?',
  keep: 'number.integer >= 1?',
  includePaths: type('string[]').optional(),
}).onUndeclaredKey('reject')

const logsPatchSchema = type({
  persist: 'boolean?',
  maxBytes: '10000 <= number <= 100000000?',
  keep: '1 <= number.integer <= 10?',
}).onUndeclaredKey('reject')

const tlsPatchSchema = type({
  enabled: 'boolean?',
}).onUndeclaredKey('reject')

const controlPatchSchema = type({
  label: '1 <= string <= 60?',
  port: '1 <= number.integer <= 65535?',
  host: bindSchema.optional(),
  openBrowser: 'boolean?',
  auth: authPatchSchema.optional(),
  tls: tlsPatchSchema.optional(),
}).onUndeclaredKey('reject')

const defaultsPatchSchema = type({
  enabled: 'boolean?',
  autostart: 'boolean?',
  bind: bindSchema.optional(),
  onPortConflict: onPortConflictSchema.optional(),
  restart: restartPatchSchema.optional(),
  health: healthPatchSchema.optional(),
  stop: stopPatchSchema.optional(),
  logBufferLines: logBufferLinesSchema.optional(),
}).onUndeclaredKey('reject')

const editableFields = {
  label: 'string?',
  enabled: 'boolean?',
  autostart: 'boolean?',
  command: 'string?',
  args: 'string[]?',
  cwd: 'string?',
  env: 'Record<string, string>?',
  dataEnvs: 'Record<string, string>?',
  bootstrap: bootstrapOrNullSchema.optional(),
  port: portSchema.optional(),
  bind: bindSchema.optional(),
  onPortConflict: onPortConflictSchema.optional(),
  restart: restartPatchSchema.optional(),
  health: healthPatchSchema.optional(),
  stop: stopPatchSchema.optional(),
  logBufferLines: logBufferLinesSchema.optional(),
  dependsOn: type('string[]').optional(),
  envFile: 'string?',
  resources: resourcesPatchSchema.optional(),
  backupPaths: type('string[]').optional(),
  backupIgnoreGenerated: 'boolean?',
} as const

export const serverPatchSchema = type(editableFields).onUndeclaredKey('reject')
export type ServerPatch = typeof serverPatchSchema.infer

export const serverCreateSchema = type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  ...editableFields,
  command: 'string',
}).onUndeclaredKey('reject')
export type ServerCreate = typeof serverCreateSchema.infer

/** Edits to the panel's own control block and to the global server defaults. */
export const settingsPatchSchema = type({
  control: controlPatchSchema.optional(),
  defaults: defaultsPatchSchema.optional(),
  logs: logsPatchSchema.optional(),
  notifications: notificationsPatchSchema.optional(),
  host: hostPatchSchema.optional(),
  backups: backupsPatchSchema.optional(),
}).onUndeclaredKey('reject')
export type SettingsPatch = typeof settingsPatchSchema.infer

export const authStatusSchema = type({
  enabled: 'boolean',
  passwordSet: 'boolean',
  passwordUpdatedAt: 'number | null',
  /**
   * An API token is set; it is shown here as a flag, never as a value. Optional so
   * a freshly built UI still parses the state of a panel process that predates it:
   * an upgrade replaces `uis/stock/dist` on disk while the old process keeps
   * serving, and a missing key must not blank the whole app.
   */
  apiTokenSet: 'boolean?',
  /** Still the boot-time default; the login page says so and exposure stays blocked. */
  usingDefaultPassword: 'boolean',
  /** The panel currently listens beyond loopback. */
  exposed: 'boolean',
  /** Non-null when that exposure is not backed by a password. */
  blockedReason: 'string | null',
  sessionTtlMs: 'number',
  cookieSecure: 'string',
  trustProxy: 'boolean',
  maxLoginAttempts: 'number',
  lockoutMs: 'number',
})
export type AuthStatus = typeof authStatusSchema.infer

export const tlsStatusSchema = type({
  enabled: 'boolean',
  certPresent: 'boolean',
  subject: 'string | null',
  issuer: 'string | null',
  validFrom: 'string | null',
  validTo: 'string | null',
  daysRemaining: 'number | null',
  fingerprint: 'string | null',
  keyMatches: 'boolean | null',
  error: 'string | null',
})
export type TlsStatus = typeof tlsStatusSchema.infer

export const telegramStatusSchema = type({
  enabled: 'boolean',
  tokenSet: 'boolean',
  chatId: 'string',
  onCrash: 'boolean',
  onUnhealthy: 'boolean',
  onForcedRestart: 'boolean',
  onRecovered: 'boolean',
  /** Host vitals breaches (disk, memory, swap, load, temperature). */
  onHost: 'boolean',
  cooldownMs: 'number',
  /** Last delivery outcome, for the settings page. */
  lastResult: 'string | null',
  lastResultAt: 'number | null',
})
export type TelegramStatus = typeof telegramStatusSchema.infer

export const notificationViewSchema = type({
  telegram: telegramStatusSchema,
})
export type NotificationView = typeof notificationViewSchema.infer

export const sessionViewSchema = type({
  authenticated: 'boolean',
  authRequired: 'boolean',
  passwordSet: 'boolean',
  /** A long-lived API token is configured; optional for the same reason as above. */
  apiTokenSet: 'boolean?',
  usingDefaultPassword: 'boolean',
  /** The boot-time password, exposed only while it is still in use. */
  defaultPassword: 'string | null',
  sessionTtlMs: 'number',
})
export type SessionView = typeof sessionViewSchema.infer

export const loginSchema = type({ password: 'string' }).onUndeclaredKey('reject')
export type LoginRequest = typeof loginSchema.infer

/** Any non-empty password is allowed; only a sanity cap on the length. */
export const passwordValueSchema = type('1 <= string <= 512')

export const passwordSchema = type({
  currentPassword: 'string?',
  newPassword: passwordValueSchema,
}).onUndeclaredKey('reject')
export type PasswordRequest = typeof passwordSchema.infer

export const serverStatusSchema = type('"stopped" | "starting" | "running" | "stopping" | "backoff" | "crashed" | "conflict"')
export type ServerStatus = typeof serverStatusSchema.infer

export const healthStateSchema = type('"disabled" | "unknown" | "healthy" | "unhealthy"')
export type HealthState = typeof healthStateSchema.infer

export const portStateSchema = type('"unknown" | "free" | "in-use"')
export type PortState = typeof portStateSchema.infer

export const logStreamSchema = type('"stdout" | "stderr" | "system"')
export type LogStream = typeof logStreamSchema.infer

export const logLineSchema = type({
  ts: 'number',
  stream: logStreamSchema,
  text: 'string',
})
export type LogLine = typeof logLineSchema.infer

export const historyEventSchema = type({
  serverId: 'string',
  ts: 'number',
  type: '"start" | "exit" | "crash" | "forced-restart" | "unhealthy" | "recovered"',
  detail: 'string',
  /** How long the process had been up, recorded on exit and crash. */
  runtimeMs: 'number?',
})
export type HistoryEvent = typeof historyEventSchema.infer

/** Rolling window stats derived from the persisted event log. */
export const serverHistorySchema = type({
  windowMs: 'number',
  /** Share of the window the process was up (null when nothing is known yet). */
  uptimeRatio: 'number | null',
  restarts: 'number',
  crashes: 'number',
  forcedRestarts: 'number',
  lastCrashAt: 'number | null',
  lastExitAt: 'number | null',
  lastRuntimeMs: 'number | null',
  events: historyEventSchema.array(),
})
export type ServerHistory = typeof serverHistorySchema.infer

export const processResourcesSchema = type({
  cpuPercent: 'number | null',
  /** RSS of the process and its descendants. */
  rssBytes: 'number | null',
  processes: 'number',
  sampledAt: 'number',
})
export type ProcessResources = typeof processResourcesSchema.infer

export const hostDiskSchema = type({
  path: 'string',
  totalBytes: 'number',
  freeBytes: 'number',
  usedPercent: 'number',
})

export const hostViewSchema = type({
  enabled: 'boolean',
  cpus: 'number',
  loadAvg: type('number[]'),
  uptimeMs: 'number',
  memoryUsedPercent: 'number',
  swapUsedPercent: 'number',
  tempCelsius: 'number | null',
  disks: hostDiskSchema.array(),
  /** Human readable threshold breaches, for the banner and notifications. */
  alerts: type('string[]'),
  sampledAt: 'number | null',
})
export type HostView = typeof hostViewSchema.infer

export const backupFileSchema = type({
  name: 'string',
  sizeBytes: 'number',
  createdAt: 'number',
  /** The archive carries a password-protected payload. */
  encrypted: 'boolean',
})

export type BackupFile = typeof backupFileSchema.infer

/** One declared data path, with the reason it will (or will not) be captured. */
export const backupPathSchema = type({
  path: 'string',
  /** Who declared it: `global`, `<serverId>:backupPaths` or `<serverId>:<ENV>`. */
  origin: 'string',
  /** false when a parent path already covers it, or it would swallow the archive dir. */
  included: 'boolean',
  note: 'string | null',
  /** The declaring entry asked for generated directories to be skipped. */
  ignoreGenerated: 'boolean?',
})
export type BackupPath = typeof backupPathSchema.infer

export const backupsViewSchema = type({
  enabled: 'boolean',
  dir: 'string',
  keep: 'number',
  /** Extra paths from the config, in addition to each server's own. */
  includePaths: type('string[]'),
  /** Every declared path that will be picked up, for the UI to show. */
  paths: backupPathSchema.array(),
  files: backupFileSchema.array(),
})
export type BackupsView = typeof backupsViewSchema.infer

/** One restorable slice of an archive: the panel's own state or a data path. */
export const restoreItemSchema = type({
  /** `config` | `secrets` | `tls`, or the data path itself. */
  id: 'string',
  label: 'string',
  kind: '"config" | "secrets" | "tls" | "data"',
  /** false when the current config does not declare it, or it is not in the archive. */
  restorable: 'boolean',
  /** Echo of the request's selection, so the checkboxes round-trip. */
  selected: 'boolean',
  note: 'string | null',
})
export type RestoreItem = typeof restoreItemSchema.infer

export const restorePlanSchema = type({
  dryRun: 'boolean',
  encrypted: 'boolean',
  /** The archive needs a password (none or a wrong one was supplied). */
  needsPassword: 'boolean',
  items: restoreItemSchema.array(),
  applied: type('string[]'),
  skipped: type('string[]'),
  /** Only the panel's own listener needs a restart; its servers are re-read live. */
  restartRequired: 'boolean',
  /** The panel re-read the restored config within this same restore. */
  reloaded: 'boolean',
  error: 'string?',
})
export type RestorePlan = typeof restorePlanSchema.infer

export const backupCreateSchema = type({
  /** Optional: encrypts the archive. Never stored. */
  password: passwordValueSchema.optional(),
}).onUndeclaredKey('reject')
export type BackupCreate = typeof backupCreateSchema.infer

export const restoreRequestSchema = type({
  name: 'string?',
  password: passwordValueSchema.optional(),
  /** Item ids to restore; omitted means every restorable item. */
  include: type('string[]').optional(),
}).onUndeclaredKey('reject')
export type RestoreRequest = typeof restoreRequestSchema.infer

/** Runtime view of a server: its effective config plus everything observed. */
export const serverViewSchema = type({
  id: 'string',
  config: serverSchema,
  bindHost: 'string',
  url: 'string | null',
  status: serverStatusSchema,
  health: healthStateSchema,
  portState: portStateSchema,
  pid: 'number | null',
  /** True when the process serving this entry was adopted, not spawned by the panel. */
  adopted: 'boolean?',
  startedAt: 'number | null',
  exitCode: 'number | null',
  exitSignal: 'string | null',
  restarts: 'number',
  maxRetries: 'number',
  lastError: 'string | null',
  nextRetryAt: 'number | null',
  unhealthySince: 'number | null',
  bufferedLines: 'number',
  history: serverHistorySchema,
  /** Last health probe latency (TCP connect or HTTP request). */
  responseMs: 'number | null',
  resources: processResourcesSchema.or(type('null')),
})
// `config` is emitted normalized (port is always `number | null`, never absent),
// while the schema accepts both forms so a hand-written payload still validates.
export type ServerView = Omit<typeof serverViewSchema.infer, 'config'> & { config: ServerConfig }

export const controlViewSchema = type({
  /** The configured panel name, for the shell to render. */
  label: 'string',
  port: 'number',
  /** The configured bind value (`local` | `lan` | ipv4). */
  host: 'string',
  /** The address actually bound. */
  bindHost: 'string',
  url: 'string',
  openBrowser: 'boolean',
  /** The live listener differs from the configured host/port. */
  restartRequired: 'boolean',
  protocol: 'string',
  auth: authStatusSchema,
  tls: tlsStatusSchema,
})
export type ControlView = typeof controlViewSchema.infer

export const appStateSchema = type({
  control: controlViewSchema,
  defaults: defaultsSchema,
  logs: logsSchema,
  notifications: notificationViewSchema,
  host: hostViewSchema,
  backups: backupsViewSchema,
  configPath: 'string',
  configError: 'string | null',
  /** The directory the panel was started from; relative entry paths use it. */
  projectDir: 'string',
  /** `HHOSTED_HOME`: every file home-hosted owns lives under here. */
  dataRoot: 'string',
  logsDir: 'string',
  servers: serverViewSchema.array(),
})
export type AppState = Omit<typeof appStateSchema.infer, 'servers'> & { servers: ServerView[] }

export const sseMessageSchema = type({
  type: '"hello" | "state" | "log" | "server"',
  ts: 'number',
  serverId: 'string?',
  state: appStateSchema.optional(),
  server: serverViewSchema.optional(),
  lines: logLineSchema.array().optional(),
})
export type SseMessage = typeof sseMessageSchema.infer

export const logQuerySchema = type({
  limit: 'string?',
})

/**
 * What a `free-port` attempt did. The pids are reported so the UI can say which
 * process left, and which listeners were deliberately left alone because this
 * panel supervises them.
 */
export const freePortResultSchema = type({
  ok: 'boolean',
  port: 'number | null',
  /** Asked to leave with SIGTERM, and the ones that ignored it. */
  terminated: 'number[]',
  forced: 'number[]',
  /** Listeners this panel supervises; never signalled. */
  skipped: 'number[]',
  /** The port answers no more after the attempt. */
  free: 'boolean',
})
export type FreePortResult = typeof freePortResultSchema.infer

export const logHistoryQuerySchema = type({
  tail: 'string?',
  /** Case-insensitive substring filter over the tail window. */
  search: 'string?',
  stream: '"stdout" | "stderr" | "system"?',
})

export const logFileInfoSchema = type({
  name: 'string',
  sizeBytes: 'number',
})

export const logServerViewSchema = type({
  serverId: 'string',
  label: 'string',
  status: serverStatusSchema,
  enabled: 'boolean',
  sizeBytes: 'number',
  files: logFileInfoSchema.array(),
})
export type LogServerView = typeof logServerViewSchema.infer

export const logServersViewSchema = type({
  servers: logServerViewSchema.array(),
})

export const logHistoryViewSchema = type({
  serverId: 'string',
  enabled: 'boolean',
  sizeBytes: 'number',
  files: type('string[]'),
  /** How many lines the search looked at, or null when not searching. */
  searched: 'number | null',
  lines: logLineSchema.array(),
})
export type LogHistoryView = typeof logHistoryViewSchema.infer

export type TelegramToken = typeof telegramTokenSchema.infer

export const notificationActionSchema = type({
  /** Optional override, so the token can be tested before it is saved. */
  botToken: 'string?',
  chatId: 'string?',
}).onUndeclaredKey('reject')
export type NotificationAction = typeof notificationActionSchema.infer

export const telegramTokenSchema = type({
  botToken: 'string >= 1',
}).onUndeclaredKey('reject')

/** The single error envelope every route answers failures with. */
export const apiErrorSchema = type({
  message: 'string',
  /** Stable, machine-readable; `AUTH_REQUIRED` also drives the login redirect. */
  code: 'string',
  detail: 'unknown',
}).onUndeclaredKey('reject')
export type ApiError = typeof apiErrorSchema.infer

/**
 * A user-supplied UI, as the settings page shows it.
 *
 * Every field is optional, and none of them is a fallback: a `ui.json` may be written by
 * the panel (which adds `uploadedAt`/`files`) **or dropped in by hand** following
 * `docs/UI_CREATION.md`, which documents only the author-facing fields. Requiring ours
 * meant a hand-written file parsed to nothing at all, taking `repo`/`tag` with it and
 * silently disabling `ui-update` for exactly the UI that declared itself.
 */
export const uiMetaSchema = type({
  'name?': 'string',
  'version?': 'string | null',
  /** Set by the panel, not by the author. */
  'uploadedAt?': 'number',
  /** Counted by the panel, not declared. */
  'files?': 'number.integer >= 1',
  /** `owner/name` of the UI's own repository, for `ui-update`. */
  'repo?': 'string',
  /** The release tag this build came from, e.g. `v0.6.0`. */
  'tag?': 'string',
  /** The release asset name, e.g. `home-hosted-ui-noc-console`. */
  'asset?': 'string',
  /** When the UI was built, in unix epoch seconds. */
  'unix?': 'number.integer >= 0',
})
export type UiMeta = typeof uiMetaSchema.infer

export const uiStatusSchema = type({
  /** A user-supplied UI is being served instead of the stock one. */
  custom: 'boolean',
  /** Where that UI lives, whether or not it exists yet. */
  dir: 'string',
  meta: uiMetaSchema.or(type('null')),
})
export type UiStatus = typeof uiStatusSchema.infer

export const tlsUploadSchema = type({
  certificate: 'string >= 1',
  privateKey: 'string >= 1',
}).onUndeclaredKey('reject')
export type TlsUpload = typeof tlsUploadSchema.infer

/** `GET /api/settings`: the panel's own configuration, as the settings page reads it. */
export const settingsViewSchema = type({
  control: controlViewSchema,
  defaults: defaultsSchema,
  logs: logsSchema,
  notifications: notificationViewSchema,
  host: hostSchema,
  backups: backupsViewSchema,
  ui: uiStatusSchema,
})
export type SettingsView = typeof settingsViewSchema.infer

/** `PATCH /api/settings` answers with the saved view, plus where the listener lands. */
export const settingsSavedSchema = settingsViewSchema.and(type({
  /** The listener is moving; reconnect at `targetUrl` when it stops being null. */
  rebinding: 'boolean',
  targetUrl: 'string | null',
}))
export type SettingsSaved = typeof settingsSavedSchema.infer
