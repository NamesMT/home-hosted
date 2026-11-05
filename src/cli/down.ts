import type { PersistentHandle } from '#src/providers/nanny-sweep'
import type { ServerConfig, StopConfig } from '#src/shared/contracts'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import { delay, dim, green, invocation, paint, refusal } from '#src/cli/io'
import { recordCleanStop } from '#src/helpers/last-stop'
import { versionMismatchNote } from '#src/helpers/version'
import { isComposeCommand } from '#src/providers/docker'

/**
 * `down` stops the panel and everything it supervises.
 *
 * A `persistent: true` entry is the one thing it deliberately leaves running, which is what
 * `--with-persistent` changes: the same stop, extended to those entries. While the panel is
 * up they are stopped through it, so the stop is recorded like a click in the UI; once it is
 * gone their nannies are signalled directly, because the state files are then the only record.
 */

export interface DownOptions {
  /** Also stop every persistent entry, in every workspace. */
  withPersistent?: boolean
}

/** Which persistent entries this stop ended, as `(workspace, id)` — what `restart` starts back. */
export interface DownResult {
  stoppedPersistent: Array<{ workspaceId: string, serverId: string }>
}

export async function runDown(options: DownOptions = {}): Promise<DownResult> {
  const { clearRuntime, configuredPanelAddress, isLiveLiveness, readRuntime, requestShutdown, runtimeLiveness } = await import('#src/helpers/daemon')

  const result: DownResult = { stoppedPersistent: [] }
  // What was running before this command did anything. The panel ends the entries itself when
  // asked, so afterwards they are simply gone — and the difference between "was running" and
  // "still running" is the only account of what was stopped. `restart` starts exactly that list.
  const before = options.withPersistent === true ? await livePersistents() : []
  // Filled by whichever path got here, so one place decides what was stopped and what survived.
  const finish = async (): Promise<DownResult> => {
    result.stoppedPersistent.push(...await reportPersistent(options, before))
    return result
  }

  const runtime = readRuntime()
  if (runtime === null) {
    // "Nothing is running" is a claim about the machine, not just about the record — and the record
    // is what `run.json` holds. A panel whose `run.json` is gone still listens, and saying "not
    // running" over it made `down && up` in a deploy script proceed against a live panel that then
    // held its port. Nothing here can *prove* ownership of a pid, so this only reports: it never
    // signals what it cannot identify.
    const leftover = await configuredPanelAddress()
    if (leftover !== null) {
      // Refused, not a success line: a deploy chain that continues here starts a second panel
      // against a live one. It says where and what to do, and signals nothing.
      refusal(`something is already answering on ${leftover}, but no run.json records which process owns it — stop it yourself, or free that port, then run \`${invocation()} up\``)
      process.exitCode = 1
      // Persistent entries are still the thing easiest to forget, so their report still runs.
      return finish()
    }
    process.stdout.write('home-hosted is not running\n')
    // The panel's absence is exactly when a persistent entry is easiest to forget: it outlives
    // the panel by design, so "nothing is running" must not be said by omission here.
    return finish()
  }

  const liveness = await runtimeLiveness(runtime)
  // Nothing at all is behind the pid, so the record is simply stale: delete it, and do not touch the
  // network — a port this record names may now belong to an unrelated service.
  if (liveness === 'gone') {
    clearRuntime()
    process.stdout.write(`home-hosted is not running (removed a stale run.json from home-hosted ${runtime.version})\n`)
    return finish()
  }

  /** What was stopped, and whether this CLI is a different release than it was. */
  const reportStopped = (forced: boolean): void => {
    process.stdout.write(`${green('stopped')}${forced ? ' (forced)' : ''} ${dim(`— was home-hosted ${runtime.version}`)}\n`)
    const note = versionMismatchNote(runtime.version)
    if (note !== null)
      process.stdout.write(`${dim(note)}\n`)
  }

  let answered = false
  // A graceful stop is under way only when the panel accepted the request or received SIGTERM.
  let stopping = true
  if (isLiveLiveness(liveness)) {
    process.stdout.write(`stopping pid ${runtime.pid}…\n`)
    // The panel's own endpoint stops supervised servers cleanly on every platform; a signal is the
    // fallback for a wedged or unreachable process. Only a pid whose identity is confirmed is ever
    // signalled, and this branch is the only one that signals at all.
    // The panel ends the persistent entries itself when asked: it is the only one that can
    // record the stop (log line, history, health) and consume the state file in order.
    answered = await requestShutdown(runtime, 4000, { withPersistent: options.withPersistent === true })
    if (!answered)
      stopping = signal(runtime.pid, 'SIGTERM')
  }
  else {
    /**
     * The pid is alive but was born **after** this record was written, so it is some other process
     * that inherited the number — and it must never be signalled.
     *
     * The graceful stop is still offered, because it authenticates itself: `/_hh/shutdown` answers
     * only to the token in this `run.json`, which only the panel that wrote it knows. A reply is
     * therefore proof the panel *is* ours, which keeps it stoppable in the one case the birth time
     * can be wrong about — a forward wall-clock step, where the kernel's `btime` moves and a live
     * panel looks recycled. Either way this returns: `runtime.pid` is not the answering process, so
     * it is not signalled and the record is left for that panel to overwrite.
     */
    const answeredByPanel = await requestShutdown(runtime, 4000, { withPersistent: options.withPersistent === true })
    if (!answeredByPanel) {
      process.stdout.write(`home-hosted is not running (the pid in run.json, ${runtime.pid}, belongs to another process — it was not signalled)\n`)
      return finish()
    }
    process.stdout.write(`stopped the panel on ${runtime.url} (its pid in run.json, ${runtime.pid}, was another process and was left alone)\n`)
    clearRuntime()
    recordCleanStop()
    return finish()
  }

  // Nothing told the process to stop, so there is nothing to wait out; go straight to the forced stop.
  const budget = stopping ? shutdownBudgetMs(await configuredServers(), options.withPersistent === true) : 0
  if (await waitForExit(runtime.pid, budget)) {
    clearRuntime()
    recordCleanStop()
    reportStopped(false)
    return finish()
  }

  process.stdout.write(`${dim('it did not stop in time — forcing')}\n`)
  forceStop(runtime.pid)
  // The forced stop's outcome decides the report, the exit code **and** whether the record may go.
  //
  // `forceStop` cannot report its own failure: `signal` swallows every error and `taskkill`'s exit
  // status is never read. This line used to discard `waitForExit`'s answer, `clearRuntime()` ran
  // regardless, and the command printed "stopped (forced)" and exited 0 — for a panel that was
  // still alive and still holding its port. Deleting run.json then destroyed the only record of it,
  // so `down && up` in a deploy script proceeded against a live panel. The graceful branch above
  // already asks this question before it clears; the forced branch is the one path that skipped it.
  if (!await waitForExit(runtime.pid, 5000)) {
    // Both lines are the refusal, and a refusal is one message on one stream (stderr): the remedy
    // is part of the reason. Printed to stdout it read as the command's answer, so a `down` in a
    // script — where stdout is the record — showed the failure in the same place success goes.
    refusal(`could not stop pid ${runtime.pid} — it is still running, and its record was kept`)
    process.stderr.write(`${dim(`stop it yourself with \`kill -9 ${runtime.pid}\` (Windows: \`taskkill /PID ${runtime.pid} /F\`), then run \`down\` again`)}\n`)
    process.exitCode = 1
    return finish()
  }
  clearRuntime()
  recordCleanStop()
  reportStopped(true)
  return finish()
}

/**
 * The persistent entries this host has running, as their state files describe them.
 *
 * Every workspace keeps its own `.state`, and only the panel normally sees all of them, so
 * `down` reads them itself — after a crash there is nobody left to ask.
 */
export async function livePersistents(): Promise<PersistentHandle[]> {
  const { livePersistentEntries } = await import('#src/providers/nanny-sweep')
  const { hhDir } = await import('#src/helpers/paths')
  return livePersistentEntries(hhDir)
}

/** `workspace/id`, because a server id is only unique inside its workspace. */
export function persistentLabel(handle: Readonly<PersistentHandle>): string {
  return `${handle.workspaceId}/${handle.serverId}`
}

/**
 * Stops what is left of the snapshot: with the panel gone each nanny is signalled directly, and
 * its state file consumed once it is really gone. Returns which were ended here and which
 * survived, so the caller can account for the rest as the panel's work.
 */
async function stopPersistents(before: PersistentHandle[]): Promise<{ done: Set<string>, survived: Set<string> }> {
  const done = new Set<string>()
  const survived = new Set<string>()
  // Read again rather than trusting the snapshot: the panel's shutdown has been happening in
  // the meantime, and a nanny it already ended must not be signalled a second time.
  const live = new Set((await livePersistents()).map(persistentLabel))
  const handles = before.filter(handle => live.has(persistentLabel(handle)))
  if (handles.length === 0)
    return { done, survived }

  const { stopPersistentEntries } = await import('#src/providers/nanny-sweep')
  const results = await stopPersistentEntries(handles, { stopFor: await stopPolicyLookup() })

  for (const result of results) {
    const label = persistentLabel(result.handle)
    if (result.stopped) {
      done.add(label)
      process.stdout.write(`${green('stopped')} persistent ${label}\n`)
      continue
    }
    survived.add(label)
    process.stderr.write(`${paint('31', 'error')} persistent ${label}: ${result.error}\n`)
  }
  // A stop that left a server running is a failed stop, never a quiet success.
  const code = exitCodeForStops(results)
  if (code !== 0)
    process.exitCode = code
  return { done, survived }
}

/**
 * The exit code these stops earn: any survivor is a failure, because the command was asked to
 * stop them and the host is still running one. Separated from the printing so the rule is
 * pinned where it can be read, not inferred from a process's status.
 */
export function exitCodeForStops(results: ReadonlyArray<Readonly<{ stopped: boolean }>>): 0 | 1 {
  return results.some(result => !result.stopped) ? 1 : 0
}

/**
 * Each entry's own `stop` policy, read from the workspace that declares it.
 *
 * The grace period is the entry's, not a constant: the nanny forwards it to the child it
 * owns, so a shorter one here would escalate to `SIGKILL` while a shutdown the config asked
 * to allow more time for was still running. A workspace whose config cannot be read falls
 * back to the defaults — the host is being brought down either way.
 */
async function stopPolicyLookup(): Promise<(handle: PersistentHandle) => StopConfig> {
  const { stopSchema } = await import('#src/shared/contracts')
  const read = await serversReader()
  const policies = new Map<string, Map<string, StopConfig>>()

  return (handle) => {
    let byId = policies.get(handle.workspaceId)
    if (byId === undefined) {
      byId = new Map(read(handle.workspaceId).map(server => [server.id, server.stop]))
      policies.set(handle.workspaceId, byId)
    }
    return byId.get(handle.serverId) ?? stopSchema.assert({})
  }
}

/** Reads one workspace's entries; a config this CLI cannot read yields none, and the host still goes down. */
async function serversReader(): Promise<(workspaceId: string) => ServerConfig[]> {
  const { WorkspaceStore } = await import('#src/config/store')
  const { workspaceServersPath, workspaceSettingsPath } = await import('#src/helpers/paths')
  return (workspaceId) => {
    try {
      const store = new WorkspaceStore(workspaceId, workspaceSettingsPath(workspaceId), workspaceServersPath(workspaceId))
      store.load()
      return store.servers
    }
    catch {
      return []
    }
  }
}

/** Every workspace's entries, read without writing anything: a missing registry is the default workspace. */
async function configuredServers(): Promise<ServerConfig[]> {
  const { WorkspaceRegistry } = await import('#src/config/workspaces')
  const { DEFAULT_WORKSPACE_ID, workspacesPath } = await import('#src/helpers/paths')
  let ids = [DEFAULT_WORKSPACE_ID]
  if (fs.existsSync(workspacesPath)) {
    const registry = new WorkspaceRegistry(workspacesPath)
    registry.load()
    if (registry.configError === null)
      ids = registry.all().map(workspace => workspace.id)
  }
  return ids.flatMap(await serversReader())
}

const SHUTDOWN_FLOOR_MS = 20_000
const SHUTDOWN_CEILING_MS = 10 * 60_000
/** `stopComposeContainers`' own `docker stop` timeout, plus its two listings. */
const COMPOSE_STOP_MS = 130_000

/**
 * How long the panel may take to stop what it supervises before `down` forces it.
 *
 * The panel stops every entry concurrently, so this is the slowest entry's stop — its grace, the
 * SIGKILL wait after it, a second round for a persistent child signalled alone, and a compose stack's
 * `docker stop` — plus a margin. A fixed wait force-killed a panel still inside a configured grace.
 */
export function shutdownBudgetMs(servers: ReadonlyArray<Pick<ServerConfig, 'command' | 'args' | 'persistent' | 'stop'>>, withPersistent: boolean): number {
  let slowest = 0
  for (const server of servers) {
    if (server.persistent && !withPersistent)
      continue
    const round = server.stop.graceMs + 2000
    let ms = round
    if (server.persistent && !server.stop.killGroup)
      ms += round
    if (server.stop.killPortHolders)
      ms += round
    if (isComposeCommand(server.command, server.args))
      ms += COMPOSE_STOP_MS
    slowest = Math.max(slowest, ms)
  }
  return Math.min(SHUTDOWN_CEILING_MS, Math.max(SHUTDOWN_FLOOR_MS, slowest + 10_000))
}

/**
 * The last step: name what the flag left running, or stop what the panel could not and account
 * for every entry that was running when this command started.
 *
 * The panel does the stopping whenever it is reachable — it is the only process that can record
 * it — so what is left of the snapshot is what still needs a signal here. Anything else in the
 * snapshot was ended by the panel, and is reported as stopped; a survivor is never reported as
 * stopped, or `restart` would treat a failed stop as a successful one.
 */
async function reportPersistent(options: DownOptions, before: PersistentHandle[] = []): Promise<DownResult['stoppedPersistent']> {
  if (options.withPersistent !== true) {
    const running = await livePersistents()
    if (running.length === 0)
      return []
    process.stdout.write(`${dim(`${running.length} persistent server(s) left running: ${running.map(persistentLabel).join(', ')}\n`)}`)
    process.stdout.write(`${dim('stop one from the panel, or pass --with-persistent')}\n`)
    return []
  }

  const ended = await stopPersistents(before)
  const stopped: DownResult['stoppedPersistent'] = []
  for (const handle of before) {
    const label = persistentLabel(handle)
    // A survivor is never reported as stopped, or `restart` would treat a failed stop as one.
    if (ended.survived.has(label))
      continue
    // Not ended here, so the panel did it on the way out: either way it is stopped, and the
    // caller cannot tell the two apart — nor should it have to.
    if (!ended.done.has(label))
      process.stdout.write(`${green('stopped')} persistent ${label}\n`)
    stopped.push({ workspaceId: handle.workspaceId, serverId: handle.serverId })
  }
  return stopped
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const { isProcessAlive } = await import('#src/helpers/daemon')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid))
      return true
    await delay(200)
  }
  return !isProcessAlive(pid)
}

/** Whether the signal was delivered; `false` for a pid that is gone or not ours to signal (EPERM). */
function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name)
    return true
  }
  catch {
    return false
  }
}

/**
 * Only the panel's own pid, as SIGKILL is on POSIX: `taskkill /T` follows parent pids, which a
 * detached spawn keeps on Windows, so it also killed every persistent entry's nanny.
 */
export function forceStopCommand(pid: number, platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  return platform === 'win32' ? ['taskkill', ['/PID', String(pid), '/F']] : null
}

function forceStop(pid: number): void {
  const command = forceStopCommand(pid)
  if (command !== null) {
    spawnSync(command[0], command[1], { windowsHide: true })
    return
  }
  signal(pid, 'SIGKILL')
}

export const downCommand = defineCommand({
  meta: { name: 'down' },
  args: {
    withPersistent: { type: 'boolean', description: 'also stop every persistent entry, in every workspace' },
  },
  run: async ({ args }) => {
    await runDown({ withPersistent: args.withPersistent === true })
  },
})
