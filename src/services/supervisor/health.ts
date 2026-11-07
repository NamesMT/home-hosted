import type { ChildProcess } from 'node:child_process'
import type { DockerMetrics } from '#src/providers/docker'
import type { ProcessSampler } from '#src/providers/proc'
import type { Entry, StartResult, SupervisorContext } from '#src/services/supervisor/entry'
import type { HealthState } from '#src/shared/contracts'
import { displayHost } from '#src/helpers/bind'
import { probeHealth } from '#src/providers/health-check'
import { delay } from '#src/services/supervisor/entry'
import { portAccepts } from '#src/services/supervisor/port-preflight'

const PORT_STATE_INTERVAL_MS = 10000
const RESOURCE_SAMPLE_INTERVAL_MS = 5000

export interface HealthContext extends SupervisorContext {
  isDisposed: () => boolean
  restart: (id: string) => Promise<StartResult>
  stopEntry: (entry: Entry) => Promise<StartResult>
}

/**
 * The health state, together with the streak that produced it. `healthFailures` and `unhealthySince`
 * describe one process's run, so anything other than `unhealthy` ends the streak — a caller that set
 * one and forgot the other left a duration counting while nothing was measured.
 */
export function setHealth(entry: Entry, health: HealthState): void {
  entry.health = health
  if (health !== 'unhealthy')
    endHealthStreak(entry)
}

/** Forgets the streak without deciding the verdict: a refused stop keeps its `conflict` outcome. */
export function endHealthStreak(entry: Entry): void {
  entry.healthFailures = 0
  entry.unhealthySince = null
}

/** The health of an entry nothing is probing: `disabled` with the probe off, else `unknown`. */
export function resetHealth(entry: Entry): void {
  setHealth(entry, entry.config.health.enabled ? 'unknown' : 'disabled')
}

/**
 * The measurements one process produced, dropped when that process is gone. Every path that ends a
 * run calls this — an adopted entry has no exit event, so a path that forgot left a stopped server
 * publishing live CPU, RSS and probe numbers. `adopted` goes too: there is no pid left to say it of.
 */
export function endProcessReadings(entry: Entry): void {
  entry.runToken += 1
  entry.pid = null
  entry.adopted = false
  entry.responseMs = null
  entry.resources = null
}

/** Loopback first, then the configured address, so a custom bind is still probed. */
function probeHosts(entry: Entry): string[] {
  const primary = '127.0.0.1'
  const configured = displayHost(entry.config.bind)
  return configured === primary ? [primary] : [primary, configured]
}

/** One probe using the configured mode (TCP or HTTP), with timing. */
async function probeEntryHealth(entry: Entry): Promise<{ healthy: boolean, ms: number, detail: string }> {
  const { port, health } = entry.config
  if (port === null)
    return { healthy: true, ms: 0, detail: 'no port configured' }

  return probeHealth({
    mode: health.mode,
    hosts: probeHosts(entry),
    port,
    timeoutMs: health.timeoutMs,
    http: health.http,
  })
}

/**
 * Announces a force restart's outcome once, the first moment the entry is serving. Every "it is up
 * again" path calls this; the pending flag makes it idempotent.
 */
export function settleRestart(ctx: SupervisorContext, entry: Entry, detail: string): void {
  const pending = entry.pendingRestart
  if (pending === null)
    return
  entry.pendingRestart = null
  // The cause is repeated: chat messages arrive out of order, and "back up" alone says not from what.
  const message = `after ${pending.cause}: ${detail}`
  ctx.log(entry, 'system', `restarted, and it is serving again — ${message}`)
  ctx.notify(entry, 'restart-ok', message)
}

/** Moves a freshly spawned child from `starting` to `running` once its port answers (or times out). */
export async function awaitReadiness(ctx: HealthContext, entry: Entry, child: ChildProcess): Promise<void> {
  const { port, health } = entry.config

  if (port === null) {
    if (entry.child !== child || entry.status !== 'starting')
      return
    entry.status = 'running'
    setHealth(entry, health.enabled ? 'unknown' : 'disabled')
    ctx.log(entry, 'system', 'running (no port configured; readiness assumed on spawn)')
    settleRestart(ctx, entry, 'it spawned and is running')
    ctx.publishServer(entry)
    return
  }

  const deadline = Date.now() + health.startTimeoutMs
  while (Date.now() < deadline) {
    if (entry.child !== child || entry.status !== 'starting' || ctx.isDisposed())
      return
    if (await portAccepts(entry, port, Math.min(health.timeoutMs, 1000))) {
      entry.portState = 'in-use'
      // In `http` mode an accept is only half a probe (the server may answer 500), so health stays
      // `unknown` and the restart outcome waits for the first real probe.
      setHealth(entry, !health.enabled ? 'disabled' : health.mode === 'http' ? 'unknown' : 'healthy')
      entry.status = 'running'
      entry.lastProbeAt = 0
      ctx.log(entry, 'system', `accepting connections on port ${port}`)
      if (health.mode !== 'http')
        settleRestart(ctx, entry, `accepting connections on port ${port}`)
      ctx.publishServer(entry)
      return
    }
    await delay(300)
  }

  if (entry.child === child && entry.status === 'starting') {
    entry.status = 'running'
    setHealth(entry, 'unhealthy')
    entry.unhealthySince = Date.now()
    ctx.log(entry, 'system', `no connection on port ${port} after ${health.startTimeoutMs}ms — supervising anyway`)
    ctx.publishServer(entry)
  }
}

/** Port occupancy on its own slow cadence, then one health probe when it is due. */
export async function probeEntry(ctx: SupervisorContext, entry: Entry, now: number): Promise<void> {
  const { port, health } = entry.config
  if (port === null || entry.probing)
    return

  entry.probing = true
  try {
    // Occupancy is shown even while stopped, so it is not gated on the health probe's timer.
    if (now - entry.lastOccupancyProbeAt >= PORT_STATE_INTERVAL_MS) {
      const occupancyToken = entry.runToken
      entry.lastOccupancyProbeAt = now
      const accepting = await portAccepts(entry, port, health.timeoutMs)
      // The same rule the health half follows: a probe answers for the run it started in. Without
      // this, a probe launched before a stop resolved afterwards and wrote its verdict onto the
      // *next* run's port state — the card then showed "free" for a port the new run was serving.
      if (entry.runToken === occupancyToken && entry.config.port === port)
        entry.portState = accepting ? 'in-use' : 'free'
    }

    if (entry.status !== 'running' || !health.enabled)
      return
    if (now - entry.lastProbeAt < health.intervalMs)
      return

    const token = entry.runToken
    const probe = await probeEntryHealth(entry)
    // The run it measured ended while it was out (a stop, a restart, an exit): not this run's verdict.
    if (entry.runToken !== token || entry.status !== 'running')
      return
    entry.lastProbeAt = now
    entry.responseMs = probe.ms
    entry.portState = probe.healthy ? 'in-use' : entry.portState

    if (probe.healthy) {
      if (entry.health === 'unhealthy') {
        ctx.log(entry, 'system', `${probe.detail} — healthy again (${probe.ms}ms)`)
        ctx.options.history.record(entry.config.id, { type: 'recovered', detail: probe.detail })
        ctx.notify(entry, 'recovered', probe.detail)
      }
      settleRestart(ctx, entry, `${probe.detail} (${probe.ms}ms)`)
      setHealth(entry, 'healthy')
      // The budget refills after `restart.resetAfterMs` of *uptime*, not on one healthy probe — that
      // made it a per-life cap of one and the force-restart loop endless.
      const servedForMs = entry.startedAt === null ? 0 : Date.now() - entry.startedAt
      if (entry.healthRestarts > 0 && servedForMs >= entry.config.restart.resetAfterMs) {
        entry.healthRestarts = 0
        ctx.persist(entry)
      }
      return
    }

    entry.healthFailures += 1
    if (entry.healthFailures >= health.unhealthyThreshold) {
      if (entry.unhealthySince === null) {
        entry.unhealthySince = now
        ctx.log(entry, 'system', `unhealthy: ${probe.detail} (${entry.healthFailures} failed probes) — warning only`)
        ctx.options.history.record(entry.config.id, { type: 'unhealthy', detail: probe.detail })
        ctx.notify(entry, 'unhealthy', probe.detail)
      }
      setHealth(entry, 'unhealthy')
    }
  }
  finally {
    entry.probing = false
  }
}

/**
 * One scan of /proc covers every live server. A docker-backed entry is measured through docker
 * instead (its containers are not the wrapper's descendants), falling back to the tree sample when
 * docker has no reading.
 */
export async function sampleResources(entries: Iterable<Entry>, sampler: ProcessSampler, docker: DockerMetrics, now: number): Promise<void> {
  const due = [...entries].filter(entry =>
    entry.pid !== null
    && (entry.child !== null || entry.adopted)
    && now - entry.resourcesSampledAt >= RESOURCE_SAMPLE_INTERVAL_MS)
  if (due.length === 0)
    return

  for (const entry of due) entry.resourcesSampledAt = now

  const composeTargets = due.flatMap(entry => entry.compose === null ? [] : [entry.compose])
  // Once per sample: the class batches every container into one `docker stats` call.
  const containerReadings = docker.readings(composeTargets, now)

  try {
    const samples = await sampler.sampleMany(due.map(entry => entry.pid!))
    for (const entry of due) {
      const summed = entry.compose === null ? undefined : containerReadings.get(entry.compose.key)
      entry.resources = summed === undefined
        ? samples.get(entry.pid!) ?? null
        : { cpuPercent: summed.cpuPercent, rssBytes: summed.rssBytes, processes: summed.processes, sampledAt: now }
    }
  }
  catch {
    // Sampling is best effort; a missing /proc must not break supervision.
  }
}

/**
 * The memory ceiling, on whatever the sample carries (summed container RSS for a docker entry). It
 * asks "is there a live process?", not "did we spawn it", so an adopted successor is held to it too.
 */
export async function enforceMemoryLimit(ctx: HealthContext, entry: Entry): Promise<boolean> {
  const limit = entry.config.resources.maxRssBytes
  const rss = entry.resources?.rssBytes ?? null
  const live = entry.child !== null || (entry.adopted && entry.pid !== null)
  if (limit <= 0 || rss === null || !live || entry.status !== 'running' || rss <= limit)
    return false

  const measured = entry.compose === null ? 'process tree' : 'containers'
  const detail = `${measured} use ${Math.round(rss / 1024 / 1024)}MB, over the ${Math.round(limit / 1024 / 1024)}MB limit`
  ctx.log(entry, 'system', `${detail} — restarting`)
  ctx.options.history.record(entry.config.id, { type: 'forced-restart', detail })
  ctx.notify(entry, 'rss', detail)
  entry.pendingRestart = { cause: 'exceeding its memory limit' }
  await ctx.restart(entry.config.id)
  return true
}

/** Unhealthy for longer than `forceRestartAfterMs`; spends one unit of the health budget when it says yes. */
export function shouldForceRestart(ctx: SupervisorContext, entry: Entry, now: number): boolean {
  const { port, health, restart } = entry.config
  if (port === null || entry.status !== 'running' || entry.health !== 'unhealthy')
    return false
  if (entry.unhealthySince === null || health.forceRestartAfterMs <= 0)
    return false
  if (now - entry.unhealthySince < health.forceRestartAfterMs)
    return false

  // Same budget as crashes, separate counter. A spent budget is the tick's `healthBudgetSpent` stop.
  if (!restart.enabled || entry.healthRestarts >= restart.maxRetries)
    return false

  entry.healthRestarts += 1
  ctx.persist(entry)
  ctx.log(entry, 'system', `unhealthy for ${health.forceRestartAfterMs}ms — forcing a restart (${entry.healthRestarts}/${restart.maxRetries})`)
  ctx.options.history.record(entry.config.id, { type: 'forced-restart', detail: `health check stayed unhealthy` })
  ctx.notify(entry, 'forced-restart', `unhealthy for ${Math.round(health.forceRestartAfterMs / 1000)}s`)
  // The restart resets health, so this is the only place that remembers an outcome is owed.
  entry.pendingRestart = { cause: 'staying unhealthy through its health check' }
  return true
}

/** Whether this entry's health budget is spent, so the tick should stop it. */
export function healthBudgetSpent(entry: Entry): boolean {
  const { port, health, restart } = entry.config
  if (port === null || entry.status !== 'running' || entry.health !== 'unhealthy')
    return false
  if (entry.unhealthySince === null || health.forceRestartAfterMs <= 0)
    return false
  return !restart.enabled || entry.healthRestarts >= restart.maxRetries
}

/**
 * Stops an entry that cannot pass its own health check once the budget is spent. `stopped`, because
 * the process really is; the reason stays on `lastError`.
 */
export async function giveUpOnHealth(ctx: HealthContext, entry: Entry): Promise<void> {
  const budgetEnabled = entry.config.restart.enabled
  const detail = budgetEnabled
    ? `stopped after ${entry.config.restart.maxRetries} health restarts (the health check kept failing)`
    : 'stopped because health restarts are disabled and the health check is failing'

  entry.pendingRestart = null
  entry.healthRestarts = 0
  entry.stoppedByPanel = true
  ctx.log(entry, 'system', detail)
  ctx.options.history.record(entry.config.id, { type: 'crash', detail })
  ctx.notify(entry, 'crash', detail)
  await ctx.stopEntry(entry)
  // After the stop, which clears `lastError` on the stopped path.
  if (!entry.removed) {
    entry.lastError = detail
    ctx.publishServer(entry)
  }
}
