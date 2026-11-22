import type { ConfigKind, MigrationPlan } from '#src/config/migrations'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, prompt } from '#src/cli/io'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings, readConfigStamp, stampConfig } from '#src/config/parse'
import { WorkspaceRegistry } from '#src/config/workspaces'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { globalSettingsPath, workspaceJobsPath, workspaceServersPath, workspaceSettingsPath } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import { errorMessage } from '#src/shared/error-message'
import { isRecord } from '#src/shared/shape'

/**
 * `migrate` lifts a state directory to the config schema this release understands:
 * it stamps the global settings, each workspace's settings and each workspace's
 * servers config, and applies any pending schema migration to them.
 *
 * Deliberately loud: it prints every step first, backs a file up before writing
 * it, refuses to write one it cannot read, and never runs on its own — a detached
 * daemon cannot prompt, so consent comes from `--yes`, from
 * `HHOSTED_MIGRATE=allow`, or from a person at a terminal.
 */

export const migrateArgs = {
  dryRun: { type: 'boolean', description: 'print what would change, write nothing' },
  yes: { type: 'boolean', alias: 'y', description: 'apply without asking (or set HHOSTED_MIGRATE=allow)' },
} as const

interface Target {
  file: string
  label: string
  kind: ConfigKind
  validate: (raw: unknown) => string | null
}

/** Every file a migration may have to stamp, and how this release reads it. */
function targets(): Target[] {
  const list: Target[] = [
    {
      file: globalSettingsPath,
      label: 'global settings',
      kind: 'global-settings',
      validate: raw => parseGlobalSettings(raw).errors[0] ?? null,
    },
  ]

  const registry = new WorkspaceRegistry()
  /**
   * `{ write: false }`, because `migrate` — and especially `migrate --dry-run` — must not create the
   * state it is inspecting.
   *
   * Measured: `migrate --dry-run` on an empty home answered *"no home-hosted state to migrate — nothing
   * at /tmp/…/settings.json"* **after** writing `.hh/workspaces.json`, so it reported an empty home and
   * had already changed it. A dry run saying "nothing was written" is a promise; `AGENTS.md` states the
   * rule this broke: *"a caller that only reads a store loads it with `{ write: false }`"*.
   */
  registry.load({ write: false })
  if (registry.configError !== null)
    fail(`cannot read ${registry.path}: ${registry.configError}`)

  for (const workspace of registry.all()) {
    list.push({
      file: workspaceSettingsPath(workspace.id),
      label: `workspace ${workspace.id} settings`,
      kind: 'workspace-settings',
      validate: raw => parseWorkspaceSettings(raw).errors[0] ?? null,
    })
    list.push({
      file: workspaceServersPath(workspace.id),
      label: `workspace ${workspace.id} servers`,
      kind: 'servers',
      validate: (raw) => {
        // The defaults live in the workspace settings; an absent one reads as schema defaults. They
        // are read from the *lifted* settings: a pending migration means the reader would refuse the
        // file as it is, and the defaults would be lost.
        let defaults: Record<string, unknown> = {}
        try {
          const settingsRaw = JSON.parse(readStateFile(workspaceSettingsPath(workspace.id))) as Record<string, unknown>
          const lifted = applyConfigMigrations(settingsRaw, readConfigStamp(settingsRaw).schemaVersion, { kind: 'workspace-settings' }).config
          defaults = (lifted.defaults ?? {}) as Record<string, unknown>
        }
        catch {
          // No settings file yet: the servers still have to be readable.
        }
        return parseServersFile(raw, defaults).errors[0] ?? null
      },
    })
  }
  return list
}

interface PlannedFile {
  target: Target
  from: number
  plan: MigrationPlan
  /** What gets written: the lifted file for a schema step, the same file restamped otherwise. */
  next: Record<string, unknown>
}

/**
 * Reads and checks one file, failing on anything this release must not write. `null` means the
 * file is already exactly what this release would write.
 */
function planFile(target: Target, replacement?: Record<string, unknown>): PlannedFile | null {
  let raw: Record<string, unknown>
  try {
    // A planned move supplies the file's post-move shape; reading it from disk would validate the
    // jobs it is about to remove.
    raw = replacement ?? JSON.parse(readStateFile(target.file)) as Record<string, unknown>
  }
  catch (error) {
    fail(`cannot read ${target.file}: ${errorMessage(error)}`)
  }

  const { schemaVersion: from, writtenBy } = readConfigStamp(raw)
  const plan = planConfigMigrations(from, { kind: target.kind })

  if (plan.tooNew)
    fail(`${target.file} was written by home-hosted ${writtenBy ?? 'a newer release'} (config schema ${from});\n  this release understands schema ${plan.to}. Install that version, or edit the file yourself.`)

  /**
   * Validate what this release will actually read: the file as-is when it needs no migration,
   * otherwise the result the steps produce.
   *
   * The parsed check cannot be run on the raw file when a migration is pending — the reader
   * refuses an older schema by design (`readStamp`), which would make `migrate` refuse every
   * config it exists to lift.
   */
  const migrated = plan.steps.length === 0 ? raw : applyConfigMigrations(raw, from, { kind: target.kind }).config
  if (!isRecord(migrated))
    fail(`${target.file} did not produce an object when migrated — refusing to write it`)
  const problem = target.validate(migrated)
  if (problem !== null)
    fail(`${target.file} is not a config this release can read: ${problem}`)

  // A chain with a gap would lift the file part-way and then stamp it as the current schema, so the
  // file would claim a shape it does not have. Refused rather than written.
  if (plan.reached !== plan.to) {
    fail(`${target.file} is schema ${from} and this release can only lift it to schema ${plan.reached} — the migration chain in configMigrations has a gap to schema ${plan.to}.
  That is a bug in this release: report it rather than editing the file.`)
  }

  const next = stampConfig(migrated)
  if (plan.steps.length === 0 && JSON.stringify(next) === JSON.stringify(raw))
    return null
  return { target, from, plan, next }
}

export async function runMigrate(dryRun: boolean, yes: boolean): Promise<void> {
  // Before anything else: a servers file holding a `job` cannot be parsed, so the move is what turns
  // it into a file this release can read. Doing it after the schema plan would report a refusal the
  // command exists to fix.
  const moves = planJobMoves()
  const files = targets()
  const existing = files.filter(target => fs.existsSync(target.file))
  if (existing.length === 0)
    fail(`no home-hosted state to migrate — nothing at ${globalSettingsPath} or any workspace`)

  // Refused before anything is written, and before the dry run reports a plan it cannot carry out.
  // A job id that both files declare is a real question — which command, which schedule — and the
  // move cannot answer it without picking one. Left to `first wins` the servers file loses the entry
  // anyway (every `kind: "job"` one leaves), so the loser would be a job that simply stopped existing
  // with the command reporting success.
  for (const move of moves) {
    if (move.collisions.length === 0)
      continue
    fail(`${move.serversFile} declares job(s) ${move.collisions.map(id => `"${id}"`).join(', ')}, which ${move.jobsFile} already has — renaming one is a decision only you can make.\n  Nothing was written. Rename the entry in one of the two files, then run this again.`)
  }

  // Every file is read and checked before any is written, so a refusal — or a "no" — on the third
  // file cannot leave the first two rewritten behind a line saying nothing was.
  //
  // A servers file a move empties of jobs is checked **as it will be after the move**: it cannot be
  // parsed as it is, and refusing it here would report the very problem this command fixes.
  const movedFrom = new Map(moves.map(move => [move.serversFile, move.servers]))
  const planned = existing
    .map(target => planFile(target, movedFrom.get(target.file)))
    .filter(entry => entry !== null)
  const lifts = planned.filter(entry => entry.plan.steps.length > 0)
  const restamps = planned.filter(entry => entry.plan.steps.length === 0)

  // A dry run has to *say* what it would stamp: an upgrader rehearsing the one command they were
  // told to rehearse must see the plan the real run carries out.
  for (const move of moves) {
    process.stdout.write(`moving ${move.ids.length} job(s) out of workspace ${move.workspaceId} servers: ${move.ids.join(', ')} → jobs.config.json\n`)
  }

  if (dryRun) {
    for (const entry of restamps)
      process.stdout.write(`stamping ${entry.target.label}: meta.writtenBy → home-hosted ${appVersion()} (schema ${entry.plan.to}, no steps)\n`)
  }
  for (const entry of lifts) {
    process.stdout.write(`migrating ${entry.target.label}: config schema ${entry.from} → ${entry.plan.to}\n`)
    for (const [index, step] of entry.plan.steps.entries())
      process.stdout.write(`  ${index + 1}. ${step.describe}\n`)
  }

  const done: string[] = []
  // A job move **is** a change, and the summary has to count it. Without this the summary counted
  // only schema files, so a home whose sole pending work was `kind: "job"` entries printed
  // "moving 1 job(s)…" and then "every file is already what home-hosted X understands — nothing to
  // migrate": a successful run that reads as a no-op, and invites a re-run that does nothing.
  const jobCount = moves.reduce((sum, move) => sum + move.ids.length, 0)
  if (dryRun) {
    if (jobCount > 0)
      done.push(green(`${jobCount} job(s) would be moved`))
    if (lifts.length > 0)
      done.push(green(`${lifts.length} file(s) would be migrated`))
    if (restamps.length > 0)
      done.push(green(`${restamps.length} file(s) would be stamped`))
    process.stdout.write(
      done.length === 0
        ? `every file is already what home-hosted ${appVersion()} understands — nothing to migrate\n`
        : `${done.join(', ')} to what home-hosted ${appVersion()} understands\n`,
    )
    process.stdout.write(`${dim('nothing was written (--dry-run)')}\n`)
    return
  }

  // The move is part of the same consent: it rewrites the file the schema plan then stamps, and a
  // person who said yes to "make this release understand my config" meant both halves.
  if (!dryRun && (yes || (process.env.HHOSTED_MIGRATE ?? '').toLowerCase() === 'allow')) {
    for (const move of moves) {
      applyJobMove(move)
      process.stdout.write(`${green(`moved ${move.ids.length} job(s) to jobs.config.json`)} in workspace ${move.workspaceId}\n`)
    }
  }

  // Consent covers the schema steps, asked once for all of them. A restamp needs none — it changes
  // `meta.writtenBy` and nothing else — but it waits for the answer, so "no" writes nothing at all.
  const consented = yes || (process.env.HHOSTED_MIGRATE ?? '').toLowerCase() === 'allow'
  if (lifts.length > 0 && !consented) {
    const steps = lifts.reduce((sum, entry) => sum + entry.plan.steps.length, 0)
    if (process.stdin.isTTY !== true)
      fail(`${lifts.map(entry => entry.target.file).join(', ')} need${lifts.length === 1 ? 's' : ''} ${steps} migration(s) and this session cannot ask.\n  re-run with --yes, or set HHOSTED_MIGRATE=allow for unattended runs`)
    const answer = await prompt(`Apply ${steps} migration(s) to ${lifts.length} file(s)? [y/N] `)
    if (!/^yes$|^y$/i.test(answer.trim())) {
      process.stdout.write('cancelled — nothing was written\n')
      return
    }
  }

  // `docs/` and `README.md` promise a `.bak` beside **each** file this command rewrites, restamps
  // included: a hand-formatted `servers.config.json` comes back reindented.
  for (const entry of [...restamps, ...lifts]) {
    fs.copyFileSync(entry.target.file, `${entry.target.file}.bak`)
    writeFileAtomic(entry.target.file, `${JSON.stringify(entry.next, null, 2)}\n`)
    if (entry.plan.steps.length > 0) {
      process.stdout.write(`${green(`migrated ${entry.target.label} to schema ${entry.plan.to}`)} in ${entry.target.file}\n`)
      process.stdout.write(`  ${dim(`previous file kept at ${entry.target.file}.bak`)}\n`)
    }
  }

  // "nothing to migrate" has to mean nothing happened, and the line a person reads to decide
  // whether to re-run has to agree with the lines above it.
  if (jobCount > 0)
    done.push(green(`${jobCount} job(s) moved`))
  if (lifts.length > 0)
    done.push(green(`${lifts.length} file(s) migrated`))
  if (restamps.length > 0)
    done.push(green(`${restamps.length} file(s) stamped`))
  if (done.length === 0)
    process.stdout.write(`every file is already what home-hosted ${appVersion()} understands — nothing to migrate\n`)
  else
    process.stdout.write(`${done.join(', ')} to what home-hosted ${appVersion()} understands\n`)
}

export const migrateCommand = defineCommand({
  meta: { name: 'migrate' },
  args: migrateArgs,
  run: async ({ args }) => {
    await runMigrate(args.dryRun === true, args.yes === true)
  },
})

/**
 * Moves `kind: "job"` entries out of `servers.config.json` into `jobs.config.json`.
 *
 * The one migration this release needs, and the reason it exists: a job that stays in a servers file
 * is **refused** on read (it would otherwise be read as a service and stop firing), so `migrate` is
 * where a person is sent — and it has to actually do the move rather than only stamp a version.
 *
 * Runs **before** the schema plan, because a file holding a job cannot be parsed yet. Reported with
 * the same `--dry-run` honesty as everything else: the plan names each job and each file it moves.
 */
export interface JobMove {
  workspaceId: string
  serversFile: string
  jobsFile: string
  /** The ids leaving the servers file. */
  ids: string[]
  /**
   * Ids the move has to leave behind because `jobs.config.json` already declares one.
   *
   * The servers file loses **every** `kind: "job"` entry, moved or not, so a collision it does not
   * write out is a job that ceases to exist — silently, with exit 0. `runMigrate` refuses the whole
   * run while this is non-empty; guessing `first wins` (or `last wins`) would pick a schedule for a
   * backup nobody asked it to pick.
   */
  collisions: string[]
  /** The servers file without them, ready to write. */
  servers: Record<string, unknown>
  /** The jobs file with them added. */
  jobs: Record<string, unknown>
}

/** Plans the moves for every workspace, without writing anything. */
export function planJobMoves(): JobMove[] {
  const registry = new WorkspaceRegistry()
  // Read-only, which is what this function's own docblock promises — a planner that seeds
  // `workspaces.json` has written before it planned.
  registry.load({ write: false })
  const moves: JobMove[] = []
  for (const workspace of registry.all()) {
    const serversFile = workspaceServersPath(workspace.id)
    const jobsFile = workspaceJobsPath(workspace.id)
    let raw: unknown
    try {
      raw = JSON.parse(readStateFile(serversFile))
    }
    catch {
      // Absent or unreadable: the schema planner reports the second, and there is nothing to move.
      continue
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { servers?: unknown }).servers))
      continue
    const document = raw as { servers: Array<Record<string, unknown>> } & Record<string, unknown>
    const leaving = document.servers.filter(entry => entry.kind === 'job')
    const staying = document.servers.filter(entry => entry.kind !== 'job')
    // A service that carries a stray `schedule` is left for the refusal to name: it says the entry is
    // not a job, and guessing that it meant to be one is not this command's call.
    if (leaving.length === 0)
      continue

    let existing: { jobs?: unknown[] } & Record<string, unknown> = {}
    try {
      existing = JSON.parse(readStateFile(jobsFile)) as typeof existing
    }
    catch {
      // No jobs file yet: this migration is what creates it.
    }
    const already = Array.isArray(existing.jobs) ? existing.jobs as Array<Record<string, unknown>> : []
    const incoming = leaving.map((entry) => {
      const job: Record<string, unknown> = {
        id: entry.id,
        enabled: entry.enabled ?? true,
        command: entry.command,
        args: entry.args ?? [],
        cwd: entry.cwd ?? '.',
        env: entry.env ?? {},
        secretEnv: entry.secretEnv ?? [],
        schedule: entry.schedule,
      }
      if (typeof entry.label === 'string' && entry.label.length > 0)
        job.label = entry.label
      return job
    })
    // An id that already exists in the jobs file is **not** overwritten: the file a person wrote by
    // hand wins, and the collision is named by the refusal that follows rather than silently resolved.
    // Every `kind: "job"` entry leaves the servers file, so an id dropped here would be the entry
    // ceasing to exist with nothing said — which is what `collisions` makes `runMigrate` refuse.
    const collisions = incoming.map(job => String(job.id)).filter(id => already.some(job => job.id === id))
    const ids = incoming.map(job => String(job.id)).filter(id => !already.some(job => job.id === id))
    moves.push({
      workspaceId: workspace.id,
      serversFile,
      jobsFile,
      ids,
      collisions,
      servers: { ...document, servers: staying },
      jobs: {
        meta: { writtenBy: `home-hosted ${appVersion()}`, schema: CONFIG_SCHEMA },
        jobs: [...already, ...incoming.filter(job => ids.includes(String(job.id)))],
      },
    })
  }
  return moves
}

/** Writes a planned move, keeping a `.bak` of each file it touches — the command's standing promise. */
export function applyJobMove(move: JobMove): void {
  fs.copyFileSync(move.serversFile, `${move.serversFile}.bak`)
  writeFileAtomic(move.serversFile, `${JSON.stringify(move.servers, null, 2)}\n`)
  if (!fs.existsSync(move.jobsFile)) {
    writeFileAtomic(move.jobsFile, `${JSON.stringify(move.jobs, null, 2)}\n`)
    return
  }
  fs.copyFileSync(move.jobsFile, `${move.jobsFile}.bak`)
  writeFileAtomic(move.jobsFile, `${JSON.stringify(move.jobs, null, 2)}\n`)
}
