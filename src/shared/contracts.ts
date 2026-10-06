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

/**
 * A top-level unit: its own settings, servers, secrets, logs and nanny state
 * under `$HHOSTED_HOME/.hh/<id>/`. The id is the directory name and never
 * changes; the label is what a person reads and may rename at will.
 */
export const workspaceIdSchema = type('/^[a-z0-9][a-z0-9_-]*$/')
export const workspaceSchema = type({
  id: workspaceIdSchema,
  label: '1 <= string <= 60',
}).onUndeclaredKey('reject')
export type Workspace = typeof workspaceSchema.infer

/** `id` is optional; when omitted it is derived from the label. */
export const workspaceCreateSchema = type({
  'id?': workspaceIdSchema,
  'label?': '1 <= string <= 60',
}).onUndeclaredKey('reject')
export type WorkspaceCreate = typeof workspaceCreateSchema.infer

export const workspaceRenameSchema = type({
  label: '1 <= string <= 60',
}).onUndeclaredKey('reject')
export type WorkspaceRename = typeof workspaceRenameSchema.infer

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
  /**
   * Handed to a nanny process that owns the pipes, so the entry keeps running when
   * this panel stops, restarts or is killed. `down`/`stop-all` leave it alone and
   * report it; only an explicit stop or restart stops it.
   */
  persistent: 'boolean = false',
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
  /** Idle timeout: a session dies this long after its **last** request, not after login. */
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
  /** Dynamic DNS changes and failures. */
  onDdns: 'boolean = true',
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

/** A record family the DDNS engine can point at this host. */
export const ddnsRecordTypeSchema = type.enumerated('A', 'AAAA')
export type DdnsRecordType = typeof ddnsRecordTypeSchema.infer

/**
 * One DNS provider account. Its credentials are secrets and live in the secrets
 * file keyed by this `id`, never in the config.
 */
export const ddnsAccountSchema = type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  provider: 'string >= 1',
  label: 'string = ""',
}).onUndeclaredKey('reject')
export type DdnsAccount = typeof ddnsAccountSchema.infer

/**
 * A hostname to keep pointed at this machine. That list is the whole user-facing
 * setup: the provider account it belongs to, and (optionally) which families.
 */
export const ddnsDomainSchema = type({
  host: '/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/',
  account: 'string >= 1',
  /** Records to keep current; `A` unless the host needs IPv6 too. */
  types: ddnsRecordTypeSchema.array().default(() => ['A' as const]),
  /**
   * The registered domain (apex) this host sits in. Only needed where a
   * provider cannot look it up and the guess is wrong (three-label suffixes).
   */
  zone: 'string?',
  /** Seconds; `1` means "automatic" where the provider supports it. */
  ttl: 'number.integer >= 1?',
  /** Proxying is a property of the record, not the panel: Cloudflare only. */
  proxied: 'boolean = false',
  enabled: 'boolean = true',
}).onUndeclaredKey('reject')
export type DdnsDomain = typeof ddnsDomainSchema.infer

/** Which public IP families to detect; a provider is only called for the ones declared. */
export const ddnsIpv4Schema = type({
  enabled: 'boolean = true',
  /** Override the public-IP endpoint; empty uses the built-in list. */
  url: 'string = ""',
}).onUndeclaredKey('reject')

export const ddnsIpv6Schema = type({
  enabled: 'boolean = false',
  url: 'string = ""',
}).onUndeclaredKey('reject')

/**
 * Dynamic DNS: keep a list of hostnames pointed at this machine's public IP.
 * Probing is cheap and constant; a provider is only called when the address it
 * last confirmed differs, which is what keeps simple endpoints (FreeDNS, No-IP)
 * inside their rate limits.
 */
export const ddnsConfigSchema = type({
  enabled: 'boolean = false',
  /** How often the public address is re-checked. */
  intervalMs: 'number >= 60000 = 300000',
  ipv4: ddnsIpv4Schema.default(() => ({})),
  ipv6: ddnsIpv6Schema.default(() => ({})),
  /** Default TTL for the records that accept one. */
  ttl: 'number.integer >= 1 = 1',
  accounts: ddnsAccountSchema.array().default(() => []),
  domains: ddnsDomainSchema.array().default(() => []),
}).onUndeclaredKey('reject')
export type DdnsConfig = typeof ddnsConfigSchema.infer

export const ddnsRecordStateSchema = type('"pending" | "ok" | "unchanged" | "error" | "skipped"')
export type DdnsRecordState = typeof ddnsRecordStateSchema.infer

/** What happened to one hostname on the last pass. */
export const ddnsRecordViewSchema = type({
  host: 'string',
  account: 'string',
  provider: 'string',
  type: ddnsRecordTypeSchema,
  ip: 'string | null',
  state: ddnsRecordStateSchema,
  message: 'string | null',
  updatedAt: 'number | null',
})
export type DdnsRecordView = typeof ddnsRecordViewSchema.infer

/** Live DDNS state, as the state frame and the settings page read it. */
export const ddnsStatusSchema = type({
  enabled: 'boolean',
  running: 'boolean',
  lastRunAt: 'number | null',
  lastResult: 'string | null',
  ipv4: 'string | null',
  ipv6: 'string | null',
  records: ddnsRecordViewSchema.array(),
})
export type DdnsStatus = typeof ddnsStatusSchema.infer

/** What a provider needs from the person configuring it. */
export const ddnsProviderFieldSchema = type({
  key: 'string',
  label: 'string',
  hint: 'string = ""',
  optional: 'boolean = false',
})
export type DdnsProviderField = typeof ddnsProviderFieldSchema.infer

/** Provider capabilities, so the UI knows which options to show. */
export const ddnsProviderInfoSchema = type({
  id: 'string',
  label: 'string',
  docsUrl: 'string',
  families: ddnsRecordTypeSchema.array(),
  fields: ddnsProviderFieldSchema.array(),
  ttl: 'boolean',
  proxied: 'boolean',
  /** These credentials can also answer an ACME DNS-01 challenge (a TXT record). */
  txt: 'boolean',
})
export type DdnsProviderInfo = typeof ddnsProviderInfoSchema.infer

/** `GET /api/ddns`: the policy, the live state, and the providers this build knows. */
export const ddnsViewSchema = type({
  config: ddnsConfigSchema,
  status: ddnsStatusSchema,
  providers: ddnsProviderInfoSchema.array(),
  /** Account ids whose credentials are stored. */
  credentials: type('string[]'),
})
export type DdnsView = typeof ddnsViewSchema.infer

/**
 * `PUT /api/ddns/credentials/:id`: the secret fields that provider declares.
 *
 * The provider travels with the request because the account may still be an
 * unsaved draft — the server needs its field list, not a config entry.
 */
export const ddnsCredentialsSchema = type({
  provider: 'string >= 1',
  credentials: type('Record<string, string>'),
}).onUndeclaredKey('reject')
export type DdnsCredentials = typeof ddnsCredentialsSchema.infer

/**
 * The DDNS block as a patch: no defaults, and `accounts`/`domains` are lists a
 * patch **replaces** — a key-by-key merge cannot express removing a hostname.
 * `ipv4`/`ipv6` still merge, so a patch may decide just one of their members.
 */
export const ddnsPatchSchema = type({
  enabled: 'boolean?',
  intervalMs: 'number >= 60000?',
  ipv4: type({ enabled: 'boolean?', url: 'string?' }).onUndeclaredKey('reject').optional(),
  ipv6: type({ enabled: 'boolean?', url: 'string?' }).onUndeclaredKey('reject').optional(),
  ttl: 'number.integer >= 1?',
  accounts: ddnsAccountSchema.array().optional(),
  domains: ddnsDomainSchema.array().optional(),
}).onUndeclaredKey('reject')
export type DdnsPatch = typeof ddnsPatchSchema.infer

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
  onDdns: 'boolean?',
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
  persistent: 'boolean?',
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

/**
 * What the panel hands a persistent entry's nanny, written 0600 and unlinked by the
 * nanny as it reads it. Everything is already resolved and expanded, because
 * `Supervisor.resolveSpawn()` must stay the only resolver.
 */
export const nannySpecSchema = type({
  serverId: 'string',
  command: 'string',
  args: 'string[]',
  cwd: 'string',
  env: 'Record<string, string>',
  /** Directory of the JSONL the nanny writes; `<dir>/<id>.log`, exactly as the panel names it. */
  logDir: 'string',
  /** The same retention the panel applies, so the nanny rotates identically. */
  logs: logsSchema,
  /** How the nanny stops the child it owns. */
  stop: stopSchema,
}).onUndeclaredKey('reject')
export type NannySpec = typeof nannySpecSchema.infer

/** How the child of a nanny ended, recorded for a panel that may not have been there. */
export const nannyExitSchema = type({
  code: 'number | null',
  signal: 'string | null',
  at: 'number',
  runtimeMs: 'number',
}).onUndeclaredKey('reject')
export type NannyExit = typeof nannyExitSchema.infer

/**
 * A persistent entry's process state, written by its nanny (heartbeat included) and
 * read by the panel to re-adopt a survivor and to learn how a child it never saw
 * exit actually ended.
 */
export const nannyStateSchema = type({
  'serverId': 'string',
  'nannyPid': 'number',
  'childPid': 'number | null',
  'startedAt': 'number',
  'logFile': 'string',
  'heartbeatAt': 'number',
  'lastExit?': nannyExitSchema,
}).onUndeclaredKey('reject')
export type NannyState = typeof nannyStateSchema.infer

/** Edits to the panel-wide settings: listener, auth, TLS policy, host vitals, backups. */
export const settingsPatchSchema = type({
  control: controlPatchSchema.optional(),
  host: hostPatchSchema.optional(),
  backups: backupsPatchSchema.optional(),
}).onUndeclaredKey('reject')
export type SettingsPatch = typeof settingsPatchSchema.infer

/** Edits to one workspace's settings: server defaults, log retention, notifications. */
export const workspaceSettingsPatchSchema = type({
  defaults: defaultsPatchSchema.optional(),
  logs: logsPatchSchema.optional(),
  notifications: notificationsPatchSchema.optional(),
}).onUndeclaredKey('reject')
export type WorkspaceSettingsPatch = typeof workspaceSettingsPatchSchema.infer

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

/**
 * The reverse-proxy engine this panel can drive. One engine ships today; the
 * field exists so a config written now keeps working if a second one lands.
 */
export const proxyEngineSchema = type.enumerated('caddy')
export type ProxyEngine = typeof proxyEngineSchema.infer

/** What a route forwards to: a supervised entry, the panel itself, or a literal upstream. */
export const proxyTargetSchema = type.enumerated('server', 'panel', 'external')
export type ProxyTarget = typeof proxyTargetSchema.infer

/** `auto` lets the engine decide: a public name gets ACME, a local one its own CA. */
export const proxyTlsModeSchema = type.enumerated('auto', 'off', 'manual')
export type ProxyTlsMode = typeof proxyTlsModeSchema.infer

/**
 * One public hostname, and where it goes. A route is panel-wide on purpose — the
 * point is one domain per service across every workspace — so a target that
 * names an entry names its workspace too.
 */
export const proxyRouteSchema = type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  /** The public hostname this route answers for. */
  host: '/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/',
  enabled: 'boolean = true',
  target: proxyTargetSchema.default(() => 'server' as const),
  /** `target: "server"` — an id is only unique inside its workspace. */
  workspace: 'string = ""',
  server: 'string = ""',
  /** `target: "external"` — a literal upstream such as `http://10.0.0.5:8080`. */
  url: 'string = ""',
  /** Optional path prefix; empty serves the whole host. */
  path: 'string = ""',
  tls: proxyTlsModeSchema.default(() => 'auto' as const),
  /**
   * Which DNS account answers a DNS-01 challenge for this hostname, as
   * `<workspace>/<account>` — the account belongs to a workspace, so the proxy
   * references it rather than owning it. Empty picks the workspace's only
   * account that can write TXT records.
   */
  dnsAccount: 'string = ""',
}).onUndeclaredKey('reject')
export type ProxyRoute = typeof proxyRouteSchema.infer

/**
 * One uploaded PEM pair. The pair itself lives on disk (0600) beside the panel's
 * own; this is the entry that names it, so a route can be checked against it.
 */
export const proxyCertificateSchema = type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  label: 'string = ""',
}).onUndeclaredKey('reject')
export type ProxyCertificate = typeof proxyCertificateSchema.infer

/**
 * What a route's certificate situation is, for the page to show. `fallback` is a
 * public name the CA would not issue for, so the engine is serving its own CA.
 */
export const proxyCertificateStateSchema = type.enumerated('off', 'local', 'uploaded', 'issued', 'pending', 'failed', 'fallback')
export type ProxyCertificateState = typeof proxyCertificateStateSchema.infer

/**
 * DNS-01, answered by the panel instead of the engine.
 *
 * The engine never holds DNS credentials: it asks the panel over the ACMEProxy
 * protocol, and the panel writes the challenge record through the workspace
 * account a route names. `resolvers` overrides the nameservers Caddy uses to see
 * the record, which is what split-horizon DNS needs.
 */
export const proxyDns01Schema = type({
  /** Off means the engine uses HTTP-01/TLS-ALPN-01, exactly as before. */
  enabled: 'boolean = false',
  /** Nameservers Caddy checks the TXT record against; empty uses its own defaults. */
  resolvers: type('string[]').default(() => []),
}).onUndeclaredKey('reject')
export type ProxyDns01 = typeof proxyDns01Schema.infer

/** Reverse proxy: expose the stack through one engine, with automatic HTTPS. */
export const proxyConfigSchema = type({
  enabled: 'boolean = false',
  engine: proxyEngineSchema.default(() => 'caddy' as const),
  /** Cleartext side: ACME HTTP-01 challenges and the redirect to HTTPS. */
  httpPort: '1 <= number.integer <= 65535 = 80',
  httpsPort: '1 <= number.integer <= 65535 = 443',
  /** ACME account address; a public certificate needs one. */
  email: 'string = ""',
  /** The ACME staging endpoint: untrusted certificates, no rate-limit burn. */
  staging: 'boolean = false',
  dns01: proxyDns01Schema.default(() => ({})),
  /** PEM pairs a route with `tls: "manual"` may serve; the engine picks by SNI. */
  certificates: proxyCertificateSchema.array().default(() => []),
  routes: proxyRouteSchema.array().default(() => []),
}).onUndeclaredKey('reject')
export type ProxyConfig = typeof proxyConfigSchema.infer

/** Where the binary came from: the release we downloaded, or a path a person set. */
export const proxyEngineSourceSchema = type.enumerated('downloaded', 'custom')
export type ProxyEngineSource = typeof proxyEngineSourceSchema.infer

/** What the panel knows about the installed engine. */
export const proxyEngineStatusSchema = type({
  id: proxyEngineSchema,
  installed: 'boolean',
  /** The version the binary reports; `null` until it has been probed. */
  version: 'string | null',
  source: proxyEngineSourceSchema.or(type('null')),
  path: 'string | null',
  bytes: 'number | null',
  error: 'string | null',
})
export type ProxyEngineStatus = typeof proxyEngineStatusSchema.infer

/** Engine capabilities, so the page knows which options to offer. */
export const proxyEngineInfoSchema = type({
  id: proxyEngineSchema,
  label: 'string',
  docsUrl: 'string',
  releaseUrl: 'string',
  acme: 'boolean',
  internalCa: 'boolean',
  dns01: 'boolean',
  tcp: 'boolean',
})
export type ProxyEngineInfo = typeof proxyEngineInfoSchema.infer

export const proxyRouteStatusSchema = type.enumerated('ok', 'disabled', 'no-upstream', 'error')
export type ProxyRouteStatus = typeof proxyRouteStatusSchema.infer

/** A route as the page reads it: the config, plus the upstream resolved live. */
export const proxyRouteViewSchema = type({
  'route': proxyRouteSchema,
  'status': proxyRouteStatusSchema,
  'upstream': 'string | null',
  'message': 'string | null',
  /** Where this hostname's certificate stands. Optional: an older panel omits it. */
  'certificate?': type({
    'state': proxyCertificateStateSchema,
    'message': 'string | null',
    /**
     * For `fallback`: minutes until the engine tries the CA again by itself, read
     * from the certificate it fell back to. Optional, so an older client ignores it.
     */
    'retryInMinutes?': 'number',
  }),
})
export type ProxyRouteView = typeof proxyRouteViewSchema.infer

export const proxyRunStateSchema = type.enumerated('off', 'stopped', 'starting', 'running', 'error', 'unsupported')
export type ProxyRunState = typeof proxyRunStateSchema.infer

/** Live engine state. */
export const proxyStatusSchema = type({
  state: proxyRunStateSchema,
  pid: 'number | null',
  /** The addresses the engine serves on, for the page to show. */
  urls: type('string[]'),
  /** Days until the soonest publicly-issued certificate expires; `null` when none. */
  certExpiryDays: 'number | null',
  since: 'number | null',
  lastError: 'string | null',
})
export type ProxyStatus = typeof proxyStatusSchema.infer

/** One uploaded pair, described: what it is for, and whether it is usable. */
export const proxyCertificateViewSchema = type({
  id: 'string',
  label: 'string',
  /** Both halves are on disk. */
  present: 'boolean',
  /** The engine would serve this pair for at least one manual route. */
  used: 'boolean',
  subject: 'string | null',
  issuer: 'string | null',
  validTo: 'string | null',
  daysRemaining: 'number | null',
  /** Hostnames the pair covers, read from its SANs. */
  hosts: type('string[]'),
  error: 'string | null',
})
export type ProxyCertificateView = typeof proxyCertificateViewSchema.infer

/** `GET /api/proxy`: the policy, the engine, the live state and the resolved routes. */
/**
 * A DNS account the route table may name, flattened across workspaces so the proxy
 * page can offer one list. The account itself stays in its workspace.
 */
export const proxyDnsAccountViewSchema = type({
  workspace: 'string',
  account: 'string',
  provider: 'string',
  label: 'string',
  /** The credentials can write a TXT record, so this account can answer a challenge. */
  writesTxt: 'boolean',
  /** Credentials are stored; an account without them cannot answer yet. */
  hasCredentials: 'boolean',
})
export type ProxyDnsAccountView = typeof proxyDnsAccountViewSchema.infer

export const proxyViewSchema = type({
  'config': proxyConfigSchema,
  'engine': proxyEngineStatusSchema,
  'engines': proxyEngineInfoSchema.array(),
  'status': proxyStatusSchema,
  'routes': proxyRouteViewSchema.array(),
  /** Every uploaded pair, with what it covers and when it expires. */
  'certificates': proxyCertificateViewSchema.array(),
  /** Every DNS account a route may name. Optional: an older panel omits it. */
  'dnsAccounts?': proxyDnsAccountViewSchema.array(),
})
export type ProxyView = typeof proxyViewSchema.infer

/**
 * A route as a patch sends it: every field optional, so a client may change one
 * member of a route — or add a route with only the two fields that matter.
 */
export const proxyRoutePatchSchema = type({
  id: 'string',
  host: 'string',
  enabled: 'boolean?',
  target: proxyTargetSchema.optional(),
  workspace: 'string?',
  server: 'string?',
  url: 'string?',
  path: 'string?',
  tls: proxyTlsModeSchema.optional(),
  dnsAccount: 'string?',
}).onUndeclaredKey('reject')
export type ProxyRoutePatch = typeof proxyRoutePatchSchema.infer

/**
 * The proxy block as a patch: no defaults, and `routes` is a list a patch
 * **replaces** — a key-by-key merge cannot express removing a route.
 */
export const proxyPatchSchema = type({
  enabled: 'boolean?',
  engine: proxyEngineSchema.optional(),
  httpPort: '1 <= number.integer <= 65535?',
  httpsPort: '1 <= number.integer <= 65535?',
  email: 'string?',
  staging: 'boolean?',
  /**
   * A patch shape, not the config's: both keys are optional and merge, so a client
   * may send one without resetting the other, and an explicit `null` clears a key.
   */
  dns01: type({
    enabled: 'boolean | null?',
    resolvers: 'string[] | null?',
  }).onUndeclaredKey('reject').optional(),
  certificates: proxyCertificateSchema.array().optional(),
  routes: proxyRoutePatchSchema.array().optional(),
}).onUndeclaredKey('reject')
export type ProxyPatch = typeof proxyPatchSchema.infer

/** `PUT /api/proxy/certificates/:id`: the pair itself, plus what to call it. */
export const proxyCertificateUploadSchema = type({
  label: 'string = ""',
  certificate: 'string >= 1',
  privateKey: 'string >= 1',
}).onUndeclaredKey('reject')
export type ProxyCertificateUpload = typeof proxyCertificateUploadSchema.infer

/** `POST /api/proxy/engine`: which release to install; empty means the current one. */
export const proxyEngineInstallSchema = type({
  version: 'string = ""',
}).onUndeclaredKey('reject')
export type ProxyEngineInstall = typeof proxyEngineInstallSchema.infer

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
  /** Dynamic DNS, when this panel knows about it (optional for an older panel). */
  onDdns: 'boolean?',
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

/**
 * One selectable entry in a backup: a global item (`global:settings`,
 * `global:secrets`, `global:tls`) or a workspace, whose `items` are the
 * sub-choices a per-workspace dialog offers.
 */
export const backupEntrySchema = type({
  /** `global:settings` | `global:secrets` | `global:tls` | `workspace:<id>`. */
  'id': 'string',
  'label': 'string',
  'kind': '"settings" | "secrets" | "tls" | "workspace"',
  'workspaceId?': 'string',
  'note': 'string | null',
  /** What this entry would capture; a workspace carries several leaves. */
  'items': type({
    'id': 'string',
    'label': 'string',
    /** `settings`/`servers`/`secrets` for a workspace, `data` for a declared path. */
    'kind': '"settings" | "servers" | "secrets" | "data"',
    'path?': 'string',
    /** Who declared a data path: `global`, `<serverId>:backupPaths` or `<serverId>:<ENV>`. */
    'origin?': 'string',
    'included': 'boolean',
    'note': 'string | null',
    'ignoreGenerated?': 'boolean',
  }).array(),
})
export type BackupEntry = typeof backupEntrySchema.infer

export const backupsViewSchema = type({
  enabled: 'boolean',
  dir: 'string',
  keep: 'number',
  /** Extra paths from the global config, in addition to each server's own. */
  includePaths: type('string[]'),
  /** Every selectable entry, global first, then each workspace. */
  entries: backupEntrySchema.array(),
  files: backupFileSchema.array(),
})
export type BackupsView = typeof backupsViewSchema.infer

/** One restorable slice of an archive: a global item, a workspace item, or a data path. */
export const restoreItemSchema = type({
  /** A backup entry or leaf id (`workspace:<id>:servers`, `data:<path>`, ...). */
  'id': 'string',
  'label': 'string',
  'kind': '"settings" | "secrets" | "servers" | "tls" | "data"',
  'workspaceId?': 'string',
  /** false when the current instance does not declare it, or it is not in the archive. */
  'restorable': 'boolean',
  /** Echo of the request's selection, so the checkboxes round-trip. */
  'selected': 'boolean',
  'note': 'string | null',
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
  /** Leaf ids to capture (`global:settings`, `workspace:<id>:servers`, `data:<path>`, ...); omitted means everything. */
  include: type('string[] >= 1').optional(),
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
  'id': 'string',
  /** The workspace that owns it; optional so an older panel's frame still parses. */
  'workspaceId?': 'string',
  'config': serverSchema,
  'bindHost': 'string',
  'url': 'string | null',
  'status': serverStatusSchema,
  'health': healthStateSchema,
  'portState': portStateSchema,
  'pid': 'number | null',
  /** True when the process serving this entry was adopted, not spawned by the panel. */
  'adopted': 'boolean?',
  'startedAt': 'number | null',
  'exitCode': 'number | null',
  'exitSignal': 'string | null',
  'restarts': 'number',
  'maxRetries': 'number',
  'lastError': 'string | null',
  'nextRetryAt': 'number | null',
  'unhealthySince': 'number | null',
  'bufferedLines': 'number',
  'history': serverHistorySchema,
  /** Last health probe latency (TCP connect or HTTP request). */
  'responseMs': 'number | null',
  'resources': processResourcesSchema.or(type('null')),
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

/** Everything one workspace owns, plus the live state of its servers. */
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

export const workspaceViewSchema = type({
  'id': 'string',
  'label': 'string',
  /** The workspace's servers config; the settings file sits beside it. */
  'configPath': 'string',
  'settingsPath': 'string',
  'configError': 'string | null',
  /** Keys a newer release wrote that this one ignores. */
  'configWarnings?': type('string[]'),
  'logsDir': 'string',
  'defaults': defaultsSchema,
  'logs': logsSchema,
  'notifications': notificationViewSchema,
  /** Dynamic DNS state. Optional so a newer UI still frames an older payload. */
  'ddns?': ddnsStatusSchema,
  'serverCount': 'number',
  'runningCount': 'number',
  'crashedCount': 'number',
  'servers': serverViewSchema.array(),
})
export type WorkspaceView = typeof workspaceViewSchema.infer

/**
 * The whole panel in one frame: global state plus every workspace. Workspace
 * pages read their own subtree; the global pages read across all of them.
 */
export const appStateSchema = type({
  'control': controlViewSchema,
  'host': hostViewSchema,
  'backups': backupsViewSchema,
  'ui': uiStatusSchema,
  'workspaces': workspaceViewSchema.array(),
  /** The reverse proxy, when this panel has one. Optional: an older panel does not send it. */
  'proxy?': proxyViewSchema,
  /** The directory the panel was started from; relative entry paths use it. */
  'projectDir': 'string',
  /** `HHOSTED_HOME`: every file home-hosted owns lives under here. */
  'dataRoot': 'string',
  /** The release this panel is running. Optional: an older panel does not send one. */
  'version?': 'string',
})
export type AppState = typeof appStateSchema.infer

export const sseMessageSchema = type({
  'type': '"hello" | "state" | "log" | "server"',
  'ts': 'number',
  'workspaceId?': 'string',
  'serverId': 'string?',
  'state': appStateSchema.optional(),
  'server': serverViewSchema.optional(),
  'lines': logLineSchema.array().optional(),
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
  /**
   * Case-insensitive substring filter. Both this and `stream` are filters, so the route reads a
   * wider window than `tail` and applies them to that: filtering only the display tail would
   * report an older match as "no results", and "the last N stderr lines" as whatever happened
   * to fall in a window sized for all streams. `searched` reports how many lines were read.
   */
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

export const tlsUploadSchema = type({
  certificate: 'string >= 1',
  privateKey: 'string >= 1',
}).onUndeclaredKey('reject')
export type TlsUpload = typeof tlsUploadSchema.infer

/** `GET /api/settings`: the panel-wide configuration, as Global Settings reads it. */
export const settingsViewSchema = type({
  control: controlViewSchema,
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

/**
 * `GET /api/settings/workspace?workspace=<id>`: what a workspace owns and can
 * change on its own. Global things (listener, auth, host, backups, TLS) are not
 * here — they belong to the panel, not to any workspace.
 */
export const workspaceSettingsViewSchema = type({
  id: 'string',
  label: 'string',
  settingsPath: 'string',
  configPath: 'string',
  configError: 'string | null',
  defaults: defaultsSchema,
  logs: logsSchema,
  notifications: notificationViewSchema,
})
export type WorkspaceSettingsView = typeof workspaceSettingsViewSchema.infer

export const workspaceSettingsSavedSchema = workspaceSettingsViewSchema
export type WorkspaceSettingsSaved = WorkspaceSettingsView
