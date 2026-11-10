import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, invocation, paint } from '#src/cli/io'
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
  /**
   * How many times the entry was **started** inside the panel's history window, so the first start
   * of a never-restarted server counts 1.
   *
   * The wire field is `restarts`, which is a different quantity wearing the same name: the API's
   * `server.restarts` is the crash budget spent on the current sequence (`x/maxRetries`), reset by a
   * start someone asked for. Counting starts is not that, and "starts minus one" is not either — it
   * undercounts the moment the window clips the first start (a server up for months, restarted twice
   * today, has 2 starts in the window and 1 real restart). So the column is named for what is
   * counted, and `starts` is read too when a newer panel sends the renamed field.
   */
  starts?: number
  /** The pre-rename spelling of `starts`, still what a current panel sends. */
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

/**
 * The number of starts in the history window, from whichever spelling the panel sent.
 *
 * A panel on this release or older sends `restarts` (its route copies `ServerView.history.restarts`,
 * which counts `start` events); a panel that renames the field sends `starts`. Both are read so the
 * table is right against either, and `--json` always reports it as `starts`.
 */
function startsOf(entry: UsageEntry): number | undefined {
  return entry.starts ?? entry.restarts
}

/** The `--json` document, with the count named for what it counts rather than for the wire field. */
function toJson(body: { servers?: UsageEntry[], sampledAt?: number }): Record<string, unknown> {
  const servers = (body.servers ?? []).map((entry) => {
    const count = startsOf(entry)
    const renamed: Record<string, unknown> = { ...entry }
    // One spelling on stdout: the wire name would otherwise sit beside a STARTS column.
    delete renamed.restarts
    if (count !== undefined)
      renamed.starts = count
    return renamed
  })
  return { ...(body.sampledAt === undefined ? {} : { sampledAt: body.sampledAt }), servers }
}

export async function runUsage(input: { json?: boolean }): Promise<void> {
  const { readRuntime, requestControl, runtimeIsAlive, runtimeIsGone, clearRuntime } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null || !await runtimeIsAlive(runtime)) {
    if (runtime !== null && await runtimeIsGone(runtime))
      clearRuntime()
    fail(`home-hosted is not running — start it with \`${invocation()} up\``)
  }

  const answer = await requestControl(runtime, '/_hh/usage', 15_000, 'GET')
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    fail(`the panel answered ${answer.status} — it may predate this command; restart it on this release`)

  const body = (answer.body ?? {}) as { servers?: UsageEntry[], sampledAt?: number }
  const servers = body.servers ?? []

  if (input.json === true) {
    process.stdout.write(`${JSON.stringify(toJson(body), null, 2)}\n`)
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
    // still the one thing on this list worth fixing. Starts as well as crashes: an entry that exits
    // and is brought back counts no crash until the panel gives up on it, so CRASH alone read 0 for
    // one restarting every minute.
    cell(startsOf(entry), value => (value === 0 ? dim('0') : String(value))),
    cell(entry.crashes, value => (value === 0 ? dim('0') : paint('31', String(value)))),
    cell(entry.uptimeRatio, value => `${Math.round(value * 100)}%`),
  ])

  // STARTS, not RESTARTS: the count includes the first start, and the panel's own `restarts` (the
  // crash budget, `x/maxRetries`) is a different number under the same name. See `UsageEntry.starts`.
  const headers = ['SERVER', 'STATUS', 'CPU', 'MEMORY', 'PROCS', 'STARTS', 'CRASH', 'UP']
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
