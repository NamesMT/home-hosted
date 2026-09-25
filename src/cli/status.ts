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
  const { dataRoot } = await import('#src/helpers/paths')
  const runtime = readRuntime()

  if (runtime === null) {
    if (json)
      process.stdout.write(`${JSON.stringify({ running: false }, null, 2)}\n`)
    else
      process.stdout.write('home-hosted is not running\n')
    process.exitCode = 1
    return
  }

  const running = isProcessAlive(runtime.pid)
  const probe = running ? await probeRuntime(runtime) : { reachable: false, degraded: false }

  if (json) {
    // The token is what authorises a local shutdown; a script only needs the rest.
    const { token: _token, ...safe } = runtime
    process.stdout.write(`${JSON.stringify({ running, answering: probe.reachable, degraded: probe.degraded, ...safe }, null, 2)}\n`)
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

  const ui = new UiService({ dataRoot })
  const rows: Array<[string, string]> = [
    ['status', state],
    ['pid', running ? `${runtime.pid} · up ${uptime}` : String(runtime.pid)],
    ['url', `${runtime.url} ${dim(`(${runtime.protocol})`)}`],
    ['version', runtime.version],
    ['project', runtime.projectDir],
    ['state', runtime.dataRoot],
    ['config', runtime.configPath],
    ['log', runtime.logFile],
    ['ui', ui.custom ? `custom — ${ui.status().meta?.name ?? 'installed'} (revert with \`home-hosted ui-revert\`)` : 'stock'],
  ]

  process.stdout.write(`${bold(`home-hosted ${runtime.version}`)}\n`)
  for (const [label, value] of rows)
    process.stdout.write(`  ${dim(label.padEnd(8))} ${value}\n`)
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
