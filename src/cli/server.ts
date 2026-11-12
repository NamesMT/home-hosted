import { Buffer } from 'node:buffer'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, paint } from '#src/cli/io'

/**
 * `start`/`stop`/`restart` for one supervised server.
 *
 * The supervisor lives inside the daemon, so a single server cannot be started or
 * stopped without it: these drive the running panel over its local control channel
 * (the same token `down` uses), which needs no session and no API token.
 *
 * `restart` shares the name with the panel's own restart, which is why the id is optional:
 * bare `restart` stays "down, then up", and `restart <id>` is one entry — the same thing the
 * UI's per-server Restart button does, which the shell could not.
 */

export type ServerAction = 'start' | 'stop' | 'restart'

/** The panel's answer when a port is already free — success for `start --free-port`, refused alone. */
const NOTHING_LISTENING = /^nothing is listening on port \d+ any more$/

interface ActionBody {
  ok?: boolean
  error?: string
  message?: string
  dependents?: string[]
}

/**
 * Asks the running panel to do one thing to one entry, and turns its answer into an exit code.
 *
 * Shared by every per-server command so the "the panel is not running", "it does not know this
 * command" and "it refused, here is why" sentences exist once. Returns the body, so a caller can
 * say more about what happened; a refusal never returns at all.
 */
async function callServerAction(action: string, id: string, workspace?: string, options: { tolerateFree?: boolean } = {}): Promise<ActionBody> {
  const { clearRuntime, readRuntime, requestControl, runtimeIsAlive, runtimeIsGone } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null || !await runtimeIsAlive(runtime)) {
    // Only a record with nothing behind the pid is deleted — see `runtimeIsGone`.
    if (runtime !== null && await runtimeIsGone(runtime))
      clearRuntime()
    // A persistent entry outlives the panel, and `stop` is the one action that still has a target
    // then: its nanny, signalled the way `down --with-persistent` signals it.
    if (action === 'stop')
      return stopPersistentWithoutPanel(id, workspace)
    fail(`home-hosted is not running — start it with \`${invocation()} up\``)
  }

  const query = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
  const answer = await requestControl(runtime, `/_hh/servers/${encodeURIComponent(id)}/${action}${query}`)
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)

  const body = (answer.body ?? {}) as ActionBody
  if (body.ok !== true) {
    const reason = body.error ?? body.message
    // `start --free-port` wants the port free, so "nothing is listening" is the state it asked for;
    // for `free-port` on its own it is a refusal, because the person asked to free something.
    if (options.tolerateFree === true && reason !== undefined && NOTHING_LISTENING.test(reason))
      return { ...body, ok: true }
    if (reason !== undefined)
      fail(reason)
    // A panel from before this command answers a bare 404: say which release is running
    // rather than leaving a puzzled person staring at a status code.
    if (answer.status === 404)
      fail(`the panel on ${runtime.url} is home-hosted ${runtime.version}, which does not know this command — restart it on this release`)
    fail(`the panel answered ${answer.status}`)
  }
  return body
}

/**
 * `stop <id>` with no panel: stop the persistent entry of that id through its nanny, or say what can.
 *
 * Without a workspace the id is looked up in every workspace, and two matches are refused rather than
 * guessed — a server id is only unique inside its workspace.
 */
async function stopPersistentWithoutPanel(id: string, workspace?: string): Promise<ActionBody> {
  const { livePersistents, persistentLabel, stopPolicyLookup } = await import('#src/cli/down')
  const live = await livePersistents()
  const matches = live.filter(handle => handle.serverId === id && (workspace === undefined || workspace.length === 0 || handle.workspaceId === workspace))

  if (matches.length === 0) {
    const others = live.length === 0
      ? ''
      : `; ${live.length} persistent server(s) are still running without it (${live.map(persistentLabel).join(', ')}) — \`${invocation()} down --with-persistent\` stops them`
    fail(`home-hosted is not running, and no persistent entry "${label(id, workspace)}" is either${others}`)
  }
  if (matches.length > 1)
    fail(`"${id}" is a persistent entry in ${matches.map(handle => handle.workspaceId).join(' and ')} — name one with --workspace`)

  const { stopPersistentEntries } = await import('#src/providers/nanny-sweep')
  const [result] = await stopPersistentEntries(matches, { stopFor: await stopPolicyLookup() })
  if (result === undefined || !result.stopped)
    fail(`persistent ${persistentLabel(matches[0]!)}: ${result?.error ?? 'the stop did not complete'}`)
  process.stdout.write(`${dim('the panel is not running — stopped the persistent entry through its nanny')}\n`)
  return { ok: true }
}

/** `workspace/id`, or `id` in the default workspace. */
function label(id: string, workspace?: string): string {
  return workspace === undefined ? id : `${workspace}/${id}`
}

/**
 * How long `start` watches the entry before it reports.
 *
 * `start` on the panel returns the instant the process is spawned — right for a click, wrong for a
 * script: an entry whose command exits immediately printed "started" and exited 0, while it was
 * already in its crash-restart loop, so `start x && curl x` raced every boot. One second covers a
 * process that dies on startup without making a healthy start feel hung.
 */
const START_SETTLE_MS = 1000

/** The view fields `start` reads back to decide whether the entry actually survived. */
interface StartedView {
  status?: string
  lastError?: string | null
  restarts?: number
}

export async function runServerAction(action: ServerAction, id: string, workspace?: string): Promise<void> {
  const body = await callServerAction(action, id, workspace)

  // Both spawn, so both are verified: `restart <id>` is the same process-start path as `start`, and
  // an entry that dies on boot reports `ok` from either one.
  if (action === 'start' || action === 'restart')
    await confirmStillRunning(id, workspace)

  // The past tense is the verb: `restart` says "restarted", not "stopped".
  const verb = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'
  process.stdout.write(`${green(verb)} ${label(id, workspace)}\n`)
  // A single stop does not cascade; the panel only logged who is now running without it.
  if (action === 'stop' && (body.dependents ?? []).length > 0)
    process.stdout.write(`${paint('33', 'note')} still running and depending on this: ${body.dependents!.join(', ')}\n`)
}

/**
 * Says so when a just-started entry is already gone.
 *
 * `start` answers on spawn, so a command that exits straight away is reported as started. Reading
 * the entry back is the only honest answer, and it is a **refusal** rather than a success line: a
 * deploy chain that continues against a dead process is the failure this exists to stop.
 */
async function confirmStillRunning(id: string, workspace?: string): Promise<void> {
  const { readRuntime, requestControl } = await import('#src/helpers/daemon')
  const runtime = readRuntime()
  if (runtime === null)
    return

  await new Promise(resolve => setTimeout(resolve, START_SETTLE_MS))

  const query = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
  const answer = await requestControl(runtime, `/_hh/servers/${encodeURIComponent(id)}${query}`, 15_000, 'GET')
  if (answer === null || answer.status !== 200)
    return

  const view = (answer.body ?? {}) as StartedView
  // `running` and `starting` are both alive; `backoff` means it exited and is waiting to retry,
  // which is the case that used to read as success.
  if (view.status === 'running' || view.status === 'starting')
    return

  const why = view.lastError === null || view.lastError === undefined || view.lastError.length === 0
    ? `status is ${view.status ?? 'unknown'}`
    : view.lastError
  const tail = await lastErrorLines(id, workspace)
  const shown = tail.length === 0 ? '' : `\n${tail.map(line => `  ${line}`).join('\n')}`
  fail(`server "${label(id, workspace)}" did not stay up — ${why}${tail.length === 0 ? '' : ' — its last output:'}${shown}\nthe whole log: \`${invocation()} logs ${id}${workspace === undefined || workspace.length === 0 ? '' : ` -w ${workspace}`}\``)
}

/** How many lines of a crashed entry's own output `start`/`restart` quote. */
const CRASH_TAIL_LINES = 5

/**
 * The last lines a server wrote, from its JSONL log: stderr when it wrote any, else whatever it
 * wrote last. "It was spawned" told a person nothing; the reason a process dies on boot is almost
 * always in its last few stderr lines.
 */
export function crashTail(raw: string, count = CRASH_TAIL_LINES): string[] {
  const lines: Array<{ stream?: string, text: string }> = []
  for (const row of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (row.trim().length === 0)
      continue
    try {
      const parsed = JSON.parse(row) as { stream?: unknown, text?: unknown }
      if (typeof parsed.text === 'string')
        lines.push({ stream: typeof parsed.stream === 'string' ? parsed.stream : undefined, text: parsed.text })
    }
    catch {
      // A torn last write: skipped rather than quoted half-parsed.
    }
  }
  const stderr = lines.filter(line => line.stream === 'stderr')
  const pick = stderr.length > 0 ? stderr : lines.filter(line => line.stream !== 'system')
  return pick.slice(-count).map(line => line.text)
}

async function lastErrorLines(id: string, workspace?: string): Promise<string[]> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
  const { workspaceLogsDir, workspacesPath } = await import('#src/helpers/paths')
  const ws = workspace === undefined || workspace.length === 0 ? readDefaultWorkspaceId(workspacesPath) : workspace
  const file = path.join(workspaceLogsDir(ws), `${id}.log`)
  try {
    const stat = fs.statSync(file)
    const size = Math.min(stat.size, 64 * 1024)
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size)
      fs.readSync(handle, buffer, 0, size, stat.size - size)
      return crashTail(buffer.toString('utf8'))
    }
    finally {
      fs.closeSync(handle)
    }
  }
  catch {
    return []
  }
}

/**
 * `free-port` — ask whatever holds this entry's port to stop, then say what actually happened.
 *
 * The panel refuses what it supervises rather than signalling it, so a success is not simply
 * "ok": the report distinguishes the pids that left, the ones that ignored SIGTERM and had to be
 * killed, and any this panel owns that were deliberately left alone.
 */
export async function runFreePort(id: string, workspace?: string, options: { tolerateFree?: boolean } = {}): Promise<void> {
  const body = await callServerAction('free-port', id, workspace, { tolerateFree: options.tolerateFree }) as ActionBody & {
    port?: number | null
    terminated?: number[]
    forced?: number[]
    skipped?: number[]
    free?: boolean
  }

  const port = body.port ?? null
  const where = label(id, workspace)
  const terminated = body.terminated ?? []
  const forced = body.forced ?? []
  const skipped = body.skipped ?? []

  const parts: string[] = []
  if (terminated.length > 0)
    parts.push(`pid ${terminated.join(', ')} stopped`)
  if (forced.length > 0)
    parts.push(`pid ${forced.join(', ')} had to be killed`)
  if (skipped.length > 0)
    parts.push(`pid ${skipped.join(', ')} left alone (this panel supervises it)`)

  // `free: false` with nothing signalled is the panel saying "there was nothing to free" — either
  // the port was already idle (tolerated here, since `start --free-port` wanted exactly that) or a
  // socket survived and it refused. `free === false` also covers the tolerated answer, which is the
  // same body with `ok` flipped, so the two callers cannot drift.
  const idle = terminated.length === 0 && forced.length === 0 && skipped.length === 0
  if (port === null || idle) {
    process.stdout.write(`${green('port is free')} ${where}${port === null ? '' : ` on ${port}`}\n`)
    return
  }

  const detail = idle ? 'nothing was listening' : parts.join('; ')
  if (body.free === true) {
    process.stdout.write(`${green('freed')} port ${port} for ${where} — ${detail}\n`)
    return
  }
  // The port was taken and still is: a socket that survived SIGTERM. Exit 1, because a caller
  // scripting this needs to know the server still cannot start.
  fail(`port ${port} is still in use for ${where} — ${detail}`)
}

/**
 * `start`, and `start --free-port`.
 *
 * `--free-port` frees the port first, then starts — the one sequence a person actually wants after
 * reading "port 4010 is already in use". It is a flag on `start` rather than only a command because
 * the two calls it saves are the common case; `free-port` on its own still exists for when the intent
 * is only to unblock a port.
 */
function serverCommand(action: ServerAction) {
  const withFreePort = action === 'start'
  return defineCommand({
    // No `description`: `cli.ts` owns the one copy (`SYNOPSIS` + `SUMMARIES`) and renders it through
    // `commandHelp`, which `main()` intercepts before citty sees `--help`. citty's own usage printer is
    // the only reader of a subcommand description here and it never runs (`runCommand`, not `runMain`),
    // so a copy in the module is unreachable text that drifts — `migrate`, `up` and `ui-update` had all
    // diverged by the time this was noticed.
    meta: {
      name: action,
    },
    args: {
      // `required: false` keeps citty's own refusal out of the way: the message below
      // names the id and where to find it.
      id: { type: 'positional', required: false, description: 'the server id from the workspace\'s servers.config.json' },
      workspace: { type: 'string', alias: 'w', description: 'the workspace to act in (default: the panel\'s default workspace)' },
      ...(withFreePort
        ? { 'free-port': { type: 'boolean', description: 'free the port first, then start (what the panel\'s Free port button does)' } }
        : {}),
    },
    run: async ({ args }) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length === 0)
        fail(`${action} needs a server id — see \`${invocation()} status\` or the workspace's servers.config.json`)
      const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
      // Freeing first is not "free port, ignore the outcome, then start": a port that stays taken
      // makes the start fail with the same sentence, so stop here with the port's own reason.
      if (withFreePort && args['free-port'] === true)
        await runFreePort(id, workspace, { tolerateFree: true })
      await runServerAction(action, id, workspace)
    },
  })
}

/** `free-port <id>` — the panel's Free port button, from a shell. */
export const freePortCommand = defineCommand({
  meta: { name: 'free-port' },
  args: {
    id: { type: 'positional', required: false, description: 'the server whose port should be freed' },
    workspace: { type: 'string', alias: 'w', description: 'the workspace to act in (default: the panel\'s default workspace)' },
  },
  run: async ({ args }) => {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0)
      fail(`free-port needs a server id — see \`${invocation()} status\` or the workspace's servers.config.json`)
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
    await runFreePort(id, workspace)
  },
})

export const startCommand = serverCommand('start')
export const stopCommand = serverCommand('stop')
// `restart` is deliberately absent: bare `restart` means the *panel*, and `restart <id>` is handled by
// `cli/restart.ts` through the same `runServerAction`. A `restartServerCommand` used to be exported
// here — never wired into the command surface, so it read as an entry point nothing could reach.
