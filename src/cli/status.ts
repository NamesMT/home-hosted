import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, green, invocation, paint } from '#src/cli/io'

/** `status` answers "is it running, where, and how do I reach it". */

export const statusArgs = {
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

export async function runStatus(json: boolean): Promise<void> {
  const { configuredPanelAddress, isLiveLiveness, probeRuntime, readRuntime, runtimeLiveness } = await import('#src/helpers/daemon')
  const { UiService } = await import('#src/services/ui')
  const { hhDir: dataRoot, workspaceDir, workspacesPath } = await import('#src/helpers/paths')
  const { readLastStop } = await import('#src/helpers/last-stop')
  // The per-server log directory is the **default workspace's**, and "which one is the default" is
  // the panel's own rule (`defaultWorkspaceId`), not the `default` id: a host that declares only
  // `["media"]` writes `.hh/media/.logs/<id>.log`, and the literal path printed here named a
  // directory that never existed. Measured against a live panel of that shape, in both outputs.
  const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
  const serverLogsDir = path.join(workspaceDir(readDefaultWorkspaceId(workspacesPath)), '.logs')
  const runtime = readRuntime()

  if (runtime === null) {
    // "Not running" and "never set up" are different answers: the first says wait or start it, the
    // second says there is nothing here yet. `workspaces.json` is what tells them apart — it is
    // written by the first successful `up`/`init`, so its absence means nothing was ever created.
    const initialised = fs.existsSync(workspacesPath)
    // "You stopped it" and "it died" both leave no record: `down` deletes the record a clean stop
    // ends, and `up` deletes the one a crash left behind. Only a deliberate stop writes
    // `.last-stop.json`, so that file is the difference — reported as a field rather than left for
    // a script to infer from which keys happen to be missing.
    const lastStop = readLastStop()
    // A record is not the machine. With `run.json` gone, this branch printed "home-hosted is not
    // running" while the panel on the port its own `settings.json` names answered `GET /healthz`
    // with 200 — so a `status` in a diagnostic session denied the very panel being diagnosed.
    // `down` already probes for this shape (it refuses rather than let `down && up` start a second
    // panel over a live one); the same probe answers here, and nothing is signalled — without a
    // record there is no pid this command can prove it owns, so no pid is reported either.
    const answering = await configuredPanelAddress()
    if (json) {
      // `liveness` is always present, because the contract says so and a script should not have to
      // branch on whether a record exists. No `run.json` is not "unknown": nothing is behind the
      // pid, which is exactly `gone` — a fact, not an omission. `answering` is what tells the two
      // situations apart: a stopped panel and one still serving without its record both read
      // `running: false`, and only this field separates them.
      process.stdout.write(`${JSON.stringify({
        running: false,
        initialised,
        liveness: 'gone',
        // True only when a `down` recorded it. A crash writes no marker, so this stays false.
        exitedCleanly: lastStop !== null,
        ...(lastStop === null ? {} : { lastStopAt: lastStop.at }),
        ...(answering === null ? {} : { answeringWithoutRecord: answering }),
      }, null, 2)}\n`)
    }
    else if (answering !== null) {
      process.stdout.write(`home-hosted is not running, but something is answering on ${answering} — no run.json records which process owns it, so this cannot name or signal a pid; stop it yourself, or free that port, then run \`${invocation()} up\`\n`)
    }
    else if (initialised) {
      process.stdout.write(`home-hosted is not running — start it with \`${invocation()} up\`\n`)
    }
    else {
      process.stdout.write(`home-hosted is not running — nothing is set up here yet; \`${invocation()} init\` creates a project, \`${invocation()} up\` starts one here\n`)
    }
    process.exitCode = 1
    return
  }

  // A pid that is merely *alive* is not the panel: the OS recycles pids, so the record's own
  // `startedAt` decides whether the process behind it is still this daemon.
  const liveness = await runtimeLiveness(runtime)
  const running = isLiveLiveness(liveness)
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
      // The reason `running` is false: a dead pid (`gone`) and one the OS recycled (`recycled`)
      // are different problems, and `answering: false` alone reads as a panel that is up but wedged.
      liveness,
      answering: probe.reachable,
      degraded: probe.degraded,
      // A record still here whose process is not is the other half of the question: nobody stopped
      // this panel, so it died. Reported as a fact rather than inferred from a leftover `pid`.
      exitedCleanly: false,
      ...safe,
      logsDir: serverLogsDir,
      ui: { custom: ui.custom, name: uiLabel, version: uiMeta?.version ?? null },
    }, null, 2)}\n`)
    if (!running)
      process.exitCode = 1
    return
  }

  const uptime = formatDuration(Date.now() - runtime.startedAt)
  const state = !running
    ? liveness === 'recycled'
      // Distinct from a dead pid: the number in this record now belongs to something else, which is
      // what made `up` refuse with "already running" while nothing was actually serving.
      ? paint('31', 'stale (the pid belongs to another process now)')
      : paint('31', 'stale (the process is gone)')
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
    ['serverlogs', fs.existsSync(serverLogsDir) ? `${serverLogsDir} (one file per server: <id>.log)` : serverLogsDir],
    ['ui', ui.custom ? `custom — ${uiLabel} (revert with \`${invocation()} ui-revert\`)` : 'stock'],
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
  meta: { name: 'status' },
  args: statusArgs,
  run: async ({ args }) => {
    await runStatus(args.json === true)
  },
})
