import type { Entry, ResolvedSpawn, SiblingServer, SupervisorContext } from '#src/services/supervisor/entry'
import type { FreePortResult } from '#src/shared/contracts'
import process from 'node:process'
import { bindHost, lanAddress } from '#src/helpers/bind'
import { isOwnStack } from '#src/providers/docker'
import { identifyHolders } from '#src/providers/identity'
import { findDockerPortHolder, isPortFree, listPortHolders, probePort, releaseDockerPort, terminatePids } from '#src/providers/port'
import { processTreeOwners } from '#src/providers/proc'
import { delay } from '#src/services/supervisor/entry'

const PORT_RELEASE_RECHECK_MS = 300

/** What the port preflight found: nothing in the way, our own successor, or a blocker. */
export type PreflightConflict
  = | { kind: 'free' }
    | { kind: 'adopt', pid: number }
    | { kind: 'blocked', error: string }

/** Pids this panel owns, and the `workspace/id` behind each, which a refusal names. */
export interface SupervisedPids {
  pids: Set<number>
  owners: Map<number, string>
}

export interface PortContext extends SupervisorContext {
  supervisedPids: () => Promise<SupervisedPids>
  resolveSpawn: (entry: Entry) => ResolvedSpawn
}

/**
 * The whole process *tree* of every entry, plus the panel itself. A persistent entry's server is a
 * nanny's child and a wrapper's is one generation down, so a descendant mistaken for a stranger is
 * one `free-port` away from being killed. Sibling workspaces' roots join before the walk so their
 * descendants are covered by the same rule. The panel's own tree is *not* walked: "ours" must mean a
 * process a server owns.
 */
export async function supervisedPids(
  workspaceId: string,
  entries: Iterable<Entry>,
  siblingServers: (() => Promise<SiblingServer[]>) | undefined,
): Promise<SupervisedPids> {
  const roots: number[] = []
  const labels = new Map<number, string>()
  const own = (pid: number, label: string): void => {
    roots.push(pid)
    if (!labels.has(pid))
      labels.set(pid, label)
  }
  for (const entry of entries) {
    if (entry.pid !== null)
      own(entry.pid, `${workspaceId}/${entry.config.id}`)
    else if (entry.child?.pid !== undefined)
      own(entry.child.pid, `${workspaceId}/${entry.config.id}`)
  }

  const siblings = [...await siblingServers?.() ?? []]
  for (const sibling of siblings)
    own(sibling.pid, `${sibling.workspaceId}/${sibling.serverId}`)

  const tree = await processTreeOwners(roots)
  const owners = new Map<number, string>()
  for (const [pid, root] of tree) {
    const label = labels.get(root)
    if (label !== undefined)
      owners.set(pid, label)
  }
  tree.set(process.pid, process.pid)
  return { pids: new Set(tree.keys()), owners }
}

/**
 * Where a port can be observed for this entry: a specific bind is not reachable on loopback, and a
 * `lan` bind is reachable on loopback *and* the LAN address.
 */
export function occupancyHosts(entry: Entry): string[] {
  const configured = bindHost(entry.config.bind)
  const candidates = configured === '0.0.0.0'
    ? ['127.0.0.1', lanAddress() ?? '127.0.0.1']
    : [configured, '127.0.0.1']
  return [...new Set(candidates)]
}

/** True when the port accepts a connection on any of the entry's addresses. */
export async function portAccepts(entry: Entry, port: number, timeoutMs: number): Promise<boolean> {
  const results = await Promise.all(occupancyHosts(entry).map(host => probePort(host, port, timeoutMs)))
  return results.some(Boolean)
}

/** Whether the port is free on all of the entry's addresses. */
function portFreeOnAll(entry: Entry, port: number): () => Promise<boolean> {
  const hosts = occupancyHosts(entry)
  return async () => {
    const results = await Promise.all(hosts.map(host => isPortFree(port, host)))
    return results.every(Boolean)
  }
}

/** The port's own answer, with one short recheck: a just-closed listener can still complete a handshake. */
async function waitForPortRelease(entry: Entry, port: number): Promise<boolean> {
  if (await portFreeOnAll(entry, port)())
    return true
  await delay(PORT_RELEASE_RECHECK_MS)
  return portFreeOnAll(entry, port)()
}

/** Splits the port's listeners into ours and everyone else; only the foreign half may be signalled. */
async function portHolders(ctx: PortContext, port: number): Promise<{ ours: number[], foreign: number[], owners: Map<number, string> }> {
  const { pids: supervised, owners } = await ctx.supervisedPids()
  const holders = await listPortHolders(port)
  return {
    ours: holders.filter(pid => supervised.has(pid)),
    foreign: holders.filter(pid => !supervised.has(pid)),
    owners,
  }
}

/** A refused port names the holder **and the server that owns it**, or "stop that server" is not actionable. */
function heldByOurs(port: number, ours: number[], owners: Map<number, string>): string {
  const named = [...new Set(ours.map(pid => owners.get(pid)).filter((owner): owner is string => owner !== undefined))]
  const place = named.length === 0 ? '' : ` on ${named.join(', ')}`
  return `port ${port} is held by pid ${ours.join(', ')}, which this panel supervises${place} — stop that server instead`
}

/**
 * The holder that is this entry's own detached successor. The env marker decides where the platform
 * can read it; otherwise the entry's argv. Two candidates means we do not know which is ours, so neither.
 */
async function ownPortHolder(ctx: PortContext, entry: Entry, holders: number[]): Promise<number | null> {
  const candidates = await identifyHolders(entry.config.id, ctx.resolveSpawn(entry), holders)
  if (candidates.length > 1) {
    ctx.log(entry, 'system', `pid ${candidates.join(', ')} all look like this entry: refusing to guess which is ours, set onPortConflict to "kill" to clear the port anyway`)
    return null
  }
  return candidates[0] ?? null
}

/** The port is free again: a `conflict` it caused clears with it. */
function markPortFreed(ctx: PortContext, entry: Entry, message: string): void {
  if (entry.status === 'conflict') {
    entry.status = 'stopped'
    entry.lastError = null
  }
  entry.portState = 'free'
  ctx.log(entry, 'system', message)
  ctx.publishServer(entry)
}

/**
 * Frees the port this entry wants. Holders are listed fresh here, never taken from a message, and a
 * listener this panel supervises is refused rather than killed.
 */
export async function freePort(ctx: PortContext, entry: Entry): Promise<FreePortResult & { error?: string }> {
  const id = entry.config.id
  const empty: FreePortResult & { error?: string } = { ok: false, port: null, terminated: [], forced: [], skipped: [], free: false }
  const port = entry.config.port
  if (port === null)
    return { ...empty, error: `server "${id}" has no port configured` }
  if (entry.starting || entry.stopping)
    return { ...empty, port, error: `server "${id}" is busy — try again in a moment` }

  const { ours, foreign, owners } = await portHolders(ctx, port)
  const holders = [...ours, ...foreign]

  if (holders.length === 0) {
    // An empty pid list is not a free port: docker publishes through a root-owned proxy this user
    // cannot list, but the container can still be stopped through docker.
    const docker = await findDockerPortHolder(port)
    if (docker !== null) {
      ctx.log(entry, 'system', `freeing port ${port}: stopping the docker container "${docker.container}"`)
      const released = await releaseDockerPort(docker)
      const free = released && await waitForPortRelease(entry, port)
      if (free) {
        markPortFreed(ctx, entry, `port ${port} is free (stopped the docker container "${docker.container}")`)
        return { ...empty, ok: true, port, terminated: [], forced: [], skipped: [], free: true }
      }
      return {
        ...empty,
        port,
        error: `docker could not stop the container "${docker.container}" publishing port ${port} — check \`docker logs ${docker.container}\``,
      }
    }
    // A listener this user cannot inspect looks exactly like no listener, so probe before calling it idle.
    if (!(await waitForPortRelease(entry, port))) {
      return {
        ...empty,
        port,
        error: `port ${port} is still in use, but no listener could be attributed to it — this user cannot inspect that socket, so it cannot be freed from here`,
      }
    }
    return { ...empty, port, error: `nothing is listening on port ${port} any more` }
  }
  if (foreign.length === 0) {
    return { ...empty, port, error: heldByOurs(port, ours, owners), skipped: ours }
  }

  ctx.log(entry, 'system', `freeing port ${port}: asking pid ${foreign.join(', ')} to stop`)
  const { stopped, forced } = await terminatePids(foreign, { graceMs: entry.config.stop.graceMs })
  if (forced.length > 0)
    ctx.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)

  // A held socket can take a moment to go away, so the port decides the outcome.
  const free = await waitForPortRelease(entry, port)
  if (free) {
    markPortFreed(ctx, entry, `port ${port} is free${ours.length > 0 ? ` (pid ${ours.join(', ')} left untouched)` : ''}`)
  }
  else {
    entry.lastError = `port ${port} is still in use after killing pid ${foreign.join(', ')}`
    ctx.log(entry, 'system', entry.lastError)
    ctx.publishServer(entry)
  }

  return { ok: true, port, terminated: stopped, forced, skipped: ours, free }
}

function blocked(ctx: PortContext, entry: Entry, error: string, logLine?: string): PreflightConflict {
  entry.status = 'conflict'
  entry.lastError = error
  if (logLine !== undefined)
    ctx.log(entry, 'system', logLine)
  ctx.publishServer(entry)
  return { kind: 'blocked', error }
}

/** Decides what the entry's port allows before a spawn, applying `onPortConflict`. */
export async function preflight(ctx: PortContext, entry: Entry): Promise<PreflightConflict> {
  const port = entry.config.port
  if (port === null)
    return { kind: 'free' }

  // A busy-looking port gets a second look: a just-closed listener is the window a fast restart lands in.
  const freeOnAll = portFreeOnAll(entry, port)
  let free = await freeOnAll()
  if (!free) {
    await delay(PORT_RELEASE_RECHECK_MS)
    free = await freeOnAll()
  }

  entry.portState = free ? 'free' : 'in-use'
  if (free)
    return { kind: 'free' }

  // The supervised half is never a target; the foreign half is where our own detached successor hides.
  const { ours, foreign, owners } = await portHolders(ctx, port)
  const holders = [...ours, ...foreign]
  const own = await ownPortHolder(ctx, entry, foreign)
  // No listed pid may still be a docker-published port; name the container instead.
  const docker = holders.length === 0 ? await findDockerPortHolder(port) : null
  const suffix = holders.length > 0
    ? ` (pid ${holders.join(', ')})`
    : docker === null ? '' : ` (published by the docker container "${docker.container}")`

  // `kill` takes the port from anyone — our own successor included — but never from our own tree.
  if (entry.config.onPortConflict === 'kill') {
    if (ours.length > 0) {
      const error = heldByOurs(port, ours, owners)
      return blocked(ctx, entry, error, `${error} — not starting (onPortConflict: kill)`)
    }

    if (foreign.length === 0) {
      if (docker !== null) {
        ctx.log(entry, 'system', `port ${port} is published by the docker container "${docker.container}" — onPortConflict: kill, stopping it`)
        if (await releaseDockerPort(docker) && await waitForPortRelease(entry, port))
          return { kind: 'free' }
        return blocked(ctx, entry, `docker could not stop the container "${docker.container}" publishing port ${port}`)
      }
      ctx.log(entry, 'system', `port ${port} looks busy but no listener could be found — starting anyway`)
      return { kind: 'free' }
    }

    ctx.log(entry, 'system', `port ${port} is held by pid ${foreign.join(', ')} — onPortConflict: kill, stopping the holder`)
    return await stopPortHolders(ctx, entry, foreign, port, 'killing', freeOnAll)
  }

  // `follow` keeps a detached restart of this server; `reclaim` replaces it with a supervised one.
  if (own !== null && entry.config.onPortConflict === 'follow')
    return { kind: 'adopt', pid: own }

  if (own !== null && entry.config.onPortConflict === 'reclaim') {
    ctx.log(entry, 'system', `port ${port} is held by pid ${own}, a detached restart of this entry — replacing it with a supervised process`)
    return await stopPortHolders(ctx, entry, [own], port, 'replacing', freeOnAll)
  }

  // This entry's own compose stack already serving is not a stranger: offer `warn` to attach to it.
  const ownStack = isOwnStack(docker ?? { project: null, composeDir: null }, entry.compose)
  const hint = ownStack
    ? ` — this is this entry's own stack, already up: set onPortConflict to "warn" to attach to it`
    : own !== null
      ? ` — pid ${own} is a detached restart of this entry: set onPortConflict to "follow" to adopt it, "reclaim" to replace it with a supervised process, or "kill" to stop whatever holds the port`
      : docker === null
        ? ''
        : ` — it is published by a docker container, which \`kill\` stops through docker; \`block\` and \`warn\` leave it alone`
  // A holder another of our servers owns gets its own sentence, naming where it lives.
  const blockedError = ours.length > 0
    ? heldByOurs(port, ours, owners)
    : `port ${port} is already in use${suffix}${hint}`

  // `follow` and `reclaim` refine `block`: never a stranger's port.
  if (entry.config.onPortConflict !== 'warn')
    return blocked(ctx, entry, blockedError, `${blockedError} — not starting (onPortConflict: ${entry.config.onPortConflict})`)

  ctx.log(entry, 'system', `warning: ${blockedError} — starting anyway`)
  return { kind: 'free' }
}

/**
 * Stops the listed holders and reports whether the port came free. `kill` and `reclaim` share it so
 * neither can spawn onto a listener that is still there.
 */
async function stopPortHolders(ctx: PortContext, entry: Entry, pids: number[], port: number, word: string, freeOnAll: () => Promise<boolean>): Promise<PreflightConflict> {
  const { forced } = await terminatePids(pids, { graceMs: entry.config.stop.graceMs })
  if (forced.length > 0)
    ctx.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)

  await delay(PORT_RELEASE_RECHECK_MS)
  if (await freeOnAll()) {
    entry.portState = 'free'
    return { kind: 'free' }
  }
  const error = `port ${port} is still in use after ${word} pid ${pids.join(', ')}`
  return blocked(ctx, entry, error, error)
}
