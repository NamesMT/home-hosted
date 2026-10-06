import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, green, paint } from '#src/cli/io'

/** `status` answers "is it running, where, and how do I reach it". */

export const statusArgs = {
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

export async function runStatus(json: boolean): Promise<void> {
  const { isProcessAlive, probeRuntime, readRuntime } = await import('#src/helpers/daemon')
  const { UiService } = await import('#src/services/ui')
  const { hhDir: dataRoot, workspaceDir, DEFAULT_WORKSPACE_ID, workspacesPath } = await import('#src/helpers/paths')
  const runtime = readRuntime()

  if (runtime === null) {
    // "Not running" and "never set up" are different answers: the first says wait or start it, the
    // second says there is nothing here yet. `workspaces.json` is what tells them apart — it is
    // written by the first successful `up`/`init`, so its absence means nothing was ever created.
    const initialised = fs.existsSync(workspacesPath)
    if (json)
      process.stdout.write(`${JSON.stringify({ running: false, initialised }, null, 2)}\n`)
    else if (initialised)
      process.stdout.write('home-hosted is not running — start it with `home-hosted up`\n')
    else
      process.stdout.write('home-hosted is not running — nothing is set up here yet; `home-hosted init` creates a project, `home-hosted up` starts one here\n')
    process.exitCode = 1
    return
  }

  const running = isProcessAlive(runtime.pid)
  const probe = running ? await probeRuntime(runtime) : { reachable: false, degraded: false }

  // Read once, above both outputs, so they cannot disagree about which UI is installed — the text
  // form prints it as a row and a script asking for JSON needs it just as much.
  const ui = new UiService({ dataRoot })
  const uiMeta = ui.status().meta
  const uiLabel = ui.custom ? uiMeta?.name ?? 'installed' : 'stock'

  if (json) {
    // The token is what authorises a local shutdown; a script only needs the rest.
    const { token: _token, ...safe } = runtime
    // `logsDir` belongs here too: the text output prints it, and a script asking for JSON needs
    // the same paths — the panel console's file is not where a *server's* log lives.
    process.stdout.write(`${JSON.stringify({
      running,
      answering: probe.reachable,
      degraded: probe.degraded,
      ...safe,
      logsDir: path.join(workspaceDir(DEFAULT_WORKSPACE_ID), '.logs'),
      ui: { custom: ui.custom, name: uiLabel, version: uiMeta?.version ?? null },
    }, null, 2)}\n`)
    if (!running)
      process.exitCode = 1
    return
  }

  const uptime = formatDuration(Date.now() - runtime.startedAt)
  const state = !running
    ? paint('31', 'stale (the process is gone)')
    : probe.degraded
      ? paint('33', 'running — a server needs attention')
      : probe.reachable ? green('running') : paint('33', 'running, but not answering')

  const rows: Array<[string, string]> = [
    ['status', state],
    ['pid', running ? `${runtime.pid} · up ${uptime}` : String(runtime.pid)],
    ['url', `${runtime.url} ${dim(`(${runtime.protocol})`)}`],
    ['version', runtime.version],
    ['project', runtime.projectDir],
    ['state', runtime.dataRoot],
    ['internal', runtime.configPath],
    ['log', runtime.logFile],
    // The per-server logs sit beside the workspace's config, not beside the console log — and
    // the README says `status` prints the paths, so the one an operator needs to read a
    // *server's* log belongs here too. The filename convention is part of the answer: knowing the
    // directory does not tell you that the entry `api` writes `api.log`, and `home-hosted logs`
    // reads the *panel's* console, not a server's, so there is otherwise no CLI hint at all.
    // Shown only when the directory exists, because naming a convention for logs never written
    // would send someone looking for a file that is not there.
    ['serverlogs', (() => {
      const dir = path.join(workspaceDir(DEFAULT_WORKSPACE_ID), '.logs')
      return fs.existsSync(dir) ? `${dir} (one file per server: <id>.log)` : dir
    })()],
    ['ui', ui.custom ? `custom — ${uiLabel} (revert with \`home-hosted ui-revert\`)` : 'stock'],
  ]

  process.stdout.write(`${bold(`home-hosted ${runtime.version}`)}\n`)
  // Width from the rows, not a literal: the column was hard-coded at 8 until a 10-character
  // label ("serverlogs") was added and pushed every value out of alignment.
  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows)
    process.stdout.write(`  ${dim(label.padEnd(width))} ${value}\n`)
  if (!running)
    process.exitCode = 1
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'is it running, where, and how to reach it' },
  args: statusArgs,
  run: async ({ args }) => {
    await runStatus(args.json === true)
  },
})
