import type { DdnsFetch, DdnsRecord } from '#src/providers/ddns/types'
import type { NotificationService } from '#src/services/notifications'
import type { DdnsConfig, DdnsRecordState, DdnsRecordView, DdnsStatus } from '#src/shared/contracts'
import fs from 'node:fs'
import { writeFileAtomic } from '#src/helpers/atomic'
import { logger } from '#src/helpers/logger'
import { ddnsProvider } from '#src/providers/ddns'
import { detectPublicAddress } from '#src/providers/ddns/ip'
import { normalizeHost } from '#src/providers/ddns/types'

/** One network pass, however many hosts it covers. */
const RUN_TIMEOUT_MS = 60_000

interface CacheEntry {
  ip: string
  updatedAt: number
  zoneId?: string
  recordId?: string
}

interface DdnsStateFile {
  version: 1
  updatedAt: number
  /** Last address each `host|type` was confirmed to serve, so an unchanged IP costs no call. */
  records: Record<string, CacheEntry>
}

interface ResultEntry {
  state: DdnsRecordState
  ip: string | null
  message: string | null
  updatedAt: number | null
}

export interface DdnsDeps {
  getConfig: () => DdnsConfig
  /** Provider credentials for one account, or null when none are stored yet. */
  getCredentials: (accountId: string) => Record<string, string> | null
  notifications: NotificationService
  statePath: string
  fetchImpl?: DdnsFetch
  now?: () => number
}

function emptyState(): DdnsStateFile {
  return { version: 1, updatedAt: 0, records: {} }
}

function readState(file: string): DdnsStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DdnsStateFile>
    const records: Record<string, CacheEntry> = {}
    for (const [key, value] of Object.entries(parsed?.records ?? {})) {
      if (typeof value?.ip === 'string')
        records[key] = value
    }
    return { version: 1, updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0, records }
  }
  catch {
    // A missing or unreadable cache only costs one extra provider call.
    return emptyState()
  }
}

function cacheKey(host: string, type: string): string {
  return `${normalizeHost(host)}|${type}`
}

/**
 * Keeps a list of hostnames pointed at this machine's public address.
 *
 * Detection is cheap and runs on the interval; a provider is only called when
 * the address differs from the one it last confirmed, which is what keeps the
 * simple token endpoints (FreeDNS, No-IP) inside their rate limits.
 */
export class DdnsService {
  private readonly results = new Map<string, ResultEntry>()
  private persisted: DdnsStateFile
  private running = false
  private disposed = false
  /** Null until the first pass, so a fresh panel looks immediately. */
  private lastStartedAt: number | null = null
  private lastRunAt: number | null = null
  private lastResult: string | null = null
  private ipv4: string | null = null
  private ipv6: string | null = null

  constructor(private readonly deps: DdnsDeps) {
    this.persisted = readState(deps.statePath)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** What the state frame and the settings page read. */
  get view(): DdnsStatus {
    return {
      enabled: this.deps.getConfig().enabled,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      ipv4: this.ipv4,
      ipv6: this.ipv6,
      records: this.records(),
    }
  }

  /** One entry per configured target, with whatever the last pass learned. */
  private records(): DdnsRecordView[] {
    const config = this.deps.getConfig()
    const views: DdnsRecordView[] = []
    for (const domain of config.domains) {
      const account = config.accounts.find(entry => entry.id === domain.account)
      const provider = account === undefined ? null : ddnsProvider(account.provider)
      for (const type of domain.types) {
        const found = this.results.get(cacheKey(domain.host, type))
        views.push({
          host: domain.host,
          account: domain.account,
          provider: account?.provider ?? '',
          type,
          ip: found?.ip ?? this.persisted.records[cacheKey(domain.host, type)]?.ip ?? null,
          state: found?.state ?? (provider === null ? 'skipped' : 'pending'),
          message: found?.message ?? (account === undefined ? `unknown account "${domain.account}"` : provider === null ? `unknown provider "${account.provider}"` : null),
          updatedAt: found?.updatedAt ?? null,
        })
      }
    }
    return views
  }

  /** Makes the next tick run immediately, after a config or credential save. */
  refresh(): void {
    this.lastStartedAt = null
  }

  /**
   * Cheap enough to call every supervisor tick, and deliberately non-blocking:
   * a slow provider must never hold up health probes.
   */
  tick(now = this.now()): void {
    if (this.disposed || this.running)
      return
    const config = this.deps.getConfig()
    if (!config.enabled)
      return
    if (this.lastStartedAt !== null && now - this.lastStartedAt < config.intervalMs)
      return
    this.lastStartedAt = now
    void this.run().catch((error: unknown) => {
      logger.error('ddns pass failed', error)
    })
  }

  /** Runs one pass now; `force` re-sends addresses the cache already knows. */
  async run(options: { force?: boolean } = {}): Promise<DdnsStatus> {
    if (this.running || this.disposed)
      return this.view
    this.running = true

    const config = this.deps.getConfig()
    const signal = AbortSignal.timeout(RUN_TIMEOUT_MS)
    const fetchImpl = this.deps.fetchImpl ?? ((input, init) => fetch(input, init))
    let changed = 0
    let unchanged = 0
    let failed = 0
    let skipped = 0

    try {
      const wanted = this.wantedFamilies(config)
      const detected = {
        ipv4: wanted.ipv4 ? await detectPublicAddress('A', config.ipv4.url, fetchImpl, signal) : { ip: null, error: null },
        ipv6: wanted.ipv6 ? await detectPublicAddress('AAAA', config.ipv6.url, fetchImpl, signal) : { ip: null, error: null },
      }
      if (detected.ipv4.ip !== null)
        this.ipv4 = detected.ipv4.ip
      if (detected.ipv6.ip !== null)
        this.ipv6 = detected.ipv6.ip
      if (detected.ipv4.error !== null)
        logger.warn(`ddns: could not detect the public IPv4 address (${detected.ipv4.error})`)
      if (detected.ipv6.error !== null)
        logger.warn(`ddns: could not detect the public IPv6 address (${detected.ipv6.error})`)

      for (const domain of config.domains) {
        if (!domain.enabled)
          continue
        const account = config.accounts.find(entry => entry.id === domain.account)
        const provider = account === undefined ? null : ddnsProvider(account.provider)
        const credentials = account === undefined ? null : this.deps.getCredentials(account.id)

        for (const type of domain.types) {
          const key = cacheKey(domain.host, type)
          const family = type === 'A' ? 'ipv4' : 'ipv6'
          const familyConfig = type === 'A' ? config.ipv4 : config.ipv6
          const address = type === 'A' ? detected.ipv4.ip : detected.ipv6.ip

          if (provider === null || account === undefined) {
            this.remember(key, 'skipped', address, `unknown account or provider for "${domain.account}"`)
            skipped += 1
            continue
          }
          if (!familyConfig.enabled) {
            this.remember(key, 'skipped', address, `${type} records need ${family} detection, which is off`)
            skipped += 1
            continue
          }
          if (address === null) {
            this.remember(key, 'skipped', null, detected[family].error ?? `no public ${family} address was found`)
            skipped += 1
            continue
          }
          if (!provider.families.includes(type)) {
            this.remember(key, 'skipped', address, `${provider.label} cannot manage ${type} records`)
            skipped += 1
            continue
          }
          if (!options.force && this.persisted.records[key]?.ip === address) {
            this.remember(key, 'unchanged', address, null)
            unchanged += 1
            continue
          }

          const cache = this.persisted.records[key]
          const record: DdnsRecord = {
            host: domain.host,
            type,
            ip: address,
            ttl: domain.ttl ?? config.ttl,
            proxied: domain.proxied ?? config.proxied,
            ...(domain.zone === undefined ? {} : { zone: domain.zone }),
            ...(cache === undefined ? {} : { cache: { ...(cache.zoneId === undefined ? {} : { zoneId: cache.zoneId }), ...(cache.recordId === undefined ? {} : { recordId: cache.recordId }) } }),
          }

          const result = await provider.update(record, { credentials: credentials ?? {}, fetch: fetchImpl, signal })
          if (result.ok) {
            this.persisted.records[key] = {
              ip: address,
              updatedAt: this.now(),
              ...(result.cache?.zoneId === undefined ? {} : { zoneId: result.cache.zoneId }),
              ...(result.cache?.recordId === undefined ? {} : { recordId: result.cache.recordId }),
            }
            this.remember(key, result.changed ? 'ok' : 'unchanged', address, result.message)
            if (result.changed)
              changed += 1
            else
              unchanged += 1
          }
          else {
            this.remember(key, 'error', address, result.error ?? result.message)
            failed += 1
            logger.warn(`ddns: ${domain.host} ${type}: ${result.error ?? result.message}`)
          }
        }
      }
    }
    finally {
      this.running = false
      this.lastRunAt = this.now()
      this.persisted.updatedAt = this.lastRunAt
      this.writeState()
      this.lastResult = this.describe(changed, unchanged, failed, skipped)
      this.announce(config, { changed, failed })
    }

    return this.view
  }

  /** Only the families a configured target actually asks for. */
  private wantedFamilies(config: DdnsConfig): { ipv4: boolean, ipv6: boolean } {
    return {
      ipv4: config.ipv4.enabled && config.domains.some(domain => domain.enabled && domain.types.includes('A')),
      ipv6: config.ipv6.enabled && config.domains.some(domain => domain.enabled && domain.types.includes('AAAA')),
    }
  }

  private remember(key: string, state: DdnsRecordState, ip: string | null, message: string | null): void {
    this.results.set(key, { state, ip, message, updatedAt: this.now() })
  }

  /** Counts only: the detected addresses are shown beside it, and are the status's own. */
  private describe(changed: number, unchanged: number, failed: number, skipped: number): string {
    const parts = [
      changed > 0 ? `${changed} updated` : null,
      unchanged > 0 ? `${unchanged} already current` : null,
      failed > 0 ? `${failed} failed` : null,
      skipped > 0 ? `${skipped} skipped` : null,
    ].filter((part): part is string => part !== null)
    return parts.length === 0 ? 'nothing to update' : parts.join(', ')
  }

  /** One message per pass, so a flapping provider cannot flood the chat. */
  private announce(config: DdnsConfig, counts: { changed: number, failed: number }): void {
    if (!config.notify || (counts.changed === 0 && counts.failed === 0))
      return
    if (counts.failed > 0) {
      this.deps.notifications.notify({
        serverId: 'ddns',
        label: 'DDNS',
        reason: 'ddns-error',
        detail: this.lastResult ?? 'a dynamic DNS update failed',
      })
      return
    }
    this.deps.notifications.notify({
      serverId: 'ddns',
      label: 'DDNS',
      reason: 'ddns',
      detail: this.lastResult ?? 'a dynamic DNS record changed',
    })
  }

  private writeState(): void {
    try {
      writeFileAtomic(this.deps.statePath, `${JSON.stringify(this.persisted, null, 2)}\n`)
    }
    catch (error) {
      logger.warn(`ddns: could not save its state (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  dispose(): void {
    this.disposed = true
  }
}
