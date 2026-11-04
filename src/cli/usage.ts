import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, paint } from '#src/cli/io'
import { errorMessage } from '#src/shared/error-message'

/**
 * `usage` answers "which of my servers is eating the machine" without a browser.
 *
 * It reads one server's live CPU and memory from the panel it supervises, over the same local
 * token-plus-loopback channel `down` uses — no session, no API token, and no new `/api` route. An
 * entry with no sample says so instead of printing `0`, because a zero on a CPU column reads as
 * "idle" and hides a server nobody is measuring.
 */

export const usageArgs = {
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

interface UsageEntry {
  id: string
  workspaceId: string
  label: string
  status: string
  cpuPercent?: number
  rssBytes?: number
  processes?: number
  /** Behaviour over the panel's history window; absent when nothing is known yet. */
  restarts?: number
  crashes?: number
  uptimeRatio?: number
}

/** Bytes as a short human figure; `MB`/`GB` with one decimal, the unit an operator reads. */
function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb < 1024)
    return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** One reading, or a dash — never `0` for something that was not measured. */
function cell(read: number | undefined, render: (value: number) => string): string {
  return read === undefined ? dim('—') : render(read)
}

export async function runUsage(input: { json?: boolean }): Promise<void> {
  const { readRuntime, requestControl, runtimeIsAlive, runtimeIsGone, clearRuntime } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null || !await runtimeIsAlive(runtime)) {
    if (runtime !== null && await runtimeIsGone(runtime))
      clearRuntime()
    fail('home-hosted is not running — start it with `home-hosted up`')
  }

  const answer = await requestControl(runtime, '/_hh/usage', 15_000, 'GET')
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    fail(`the panel answered ${answer.status} — it may predate this command; restart it on this release`)

  const body = (answer.body ?? {}) as { servers?: UsageEntry[], sampledAt?: number }
  const servers = body.servers ?? []

  if (input.json === true) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
    return
  }

  if (servers.length === 0) {
    process.stdout.write(`${dim('no servers are configured in this panel')}\n`)
    return
  }

  // Sorted loudest first: the question is "what is eating the machine", so the answer leads.
  const ranked = [...servers].sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0))
  const rows = ranked.map(entry => [
    entry.workspaceId === 'default' ? entry.id : `${entry.workspaceId}/${entry.id}`,
    entry.status,
    cell(entry.cpuPercent, value => `${value.toFixed(1)}%`),
    cell(entry.rssBytes, formatBytes),
    cell(entry.processes, value => String(value)),
    // The window, not the instant: a flapping entry uses almost nothing at any sample and is
    // still the one thing on this list worth fixing.
    cell(entry.crashes, value => (value === 0 ? dim('0') : paint('31', String(value)))),
    cell(entry.uptimeRatio, value => `${Math.round(value * 100)}%`),
  ])

  const headers = ['SERVER', 'STATUS', 'CPU', 'MEMORY', 'PROCS', 'CRASH', 'UP']
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (columns: string[]): string =>
    columns.map((column, index) => column.padEnd(widths[index]!)).join('  ').trimEnd()

  process.stdout.write(`${bold(line(headers))}\n`)
  for (const row of rows)
    process.stdout.write(`${line(row)}\n`)

  if (body.sampledAt === undefined)
    process.stdout.write(`${dim('no host sample yet — readings appear once the panel has sampled')}\n`)
}

export const usageCommand = defineCommand({
  meta: { name: 'usage' },
  args: usageArgs,
  async run({ args }) {
    try {
      await runUsage({ json: args.json })
    }
    catch (error) {
      fail(errorMessage(error))
    }
  },
})
