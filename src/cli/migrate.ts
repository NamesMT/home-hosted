import type { ConfigKind, MigrationPlan } from '#src/config/migrations'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, prompt } from '#src/cli/io'
import { applyConfigMigrations, planConfigMigrations } from '#src/config/migrations'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings, readConfigStamp, stampConfig } from '#src/config/parse'
import { WorkspaceRegistry } from '#src/config/workspaces'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { globalSettingsPath, workspaceServersPath, workspaceSettingsPath } from '#src/helpers/paths'
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
  registry.load()
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
function planFile(target: Target): PlannedFile | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readStateFile(target.file)) as Record<string, unknown>
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
  const files = targets()
  const existing = files.filter(target => fs.existsSync(target.file))
  if (existing.length === 0)
    fail(`no home-hosted state to migrate — nothing at ${globalSettingsPath} or any workspace`)

  // Every file is read and checked before any is written, so a refusal — or a "no" — on the third
  // file cannot leave the first two rewritten behind a line saying nothing was.
  const planned = existing.map(planFile).filter(entry => entry !== null)
  const lifts = planned.filter(entry => entry.plan.steps.length > 0)
  const restamps = planned.filter(entry => entry.plan.steps.length === 0)

  // A dry run has to *say* what it would stamp: an upgrader rehearsing the one command they were
  // told to rehearse must see the plan the real run carries out.
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
  if (dryRun) {
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
