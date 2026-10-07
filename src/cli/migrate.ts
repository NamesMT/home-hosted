import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, prompt } from '#src/cli/io'
import { migrateLayout } from '#src/config/layout'
import { applyConfigMigrations, planConfigMigrations, UNSTAMPED_SCHEMA } from '#src/config/migrations'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings, stampConfig } from '#src/config/parse'
import { WorkspaceRegistry } from '#src/config/workspaces'
import { writeFileAtomic } from '#src/helpers/atomic'
import { globalSettingsPath, workspaceServersPath, workspaceSettingsPath } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'

/**
 * `migrate` brings a state directory up to what this release understands. It runs
 * in two layers: the one-time relocation of a pre-workspace `$HHOSTED_HOME` into
 * `.hh`, and the per-file schema stamp on the global settings, each workspace's
 * settings and each workspace's servers config.
 *
 * Deliberately loud: it prints every step first, backs a file up before writing
 * it, refuses to write one it cannot read, and never runs on its own — a detached
 * daemon cannot prompt, so consent comes from `--yes`, from
 * `HHOSTED_MIGRATE=allow`, or from a person at a terminal.
 */

export const migrateArgs = {
  config: { type: 'string', alias: 'c', description: 'the default workspace\'s servers config (default: <state>/.hh/default/servers.config.json)' },
  dryRun: { type: 'boolean', description: 'print what would change, write nothing' },
  yes: { type: 'boolean', alias: 'y', description: 'apply without asking (or set HHOSTED_MIGRATE=allow)' },
} as const

interface Target {
  file: string
  label: string
  validate: (raw: unknown) => string | null
}

/** Every file a migration may have to stamp, and how this release reads it. */
function targets(configOverride?: string): Target[] {
  const list: Target[] = [
    {
      file: globalSettingsPath,
      label: 'global settings',
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
      validate: raw => parseWorkspaceSettings(raw).errors[0] ?? null,
    })
    list.push({
      file: workspace.id === registry.defaultId && configOverride !== undefined ? configOverride : workspaceServersPath(workspace.id),
      label: `workspace ${workspace.id} servers`,
      validate: (raw) => {
        // The defaults live in the workspace settings; an absent one reads as schema defaults.
        let defaults: Record<string, unknown> = {}
        try {
          defaults = parseWorkspaceSettings(JSON.parse(fs.readFileSync(workspaceSettingsPath(workspace.id), 'utf8'))).config?.defaults as unknown as Record<string, unknown> ?? {}
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

export async function runMigrate(config: string | undefined, dryRun: boolean, yes: boolean): Promise<void> {
  const relocated = migrateLayout()
  if (relocated.migrated) {
    process.stdout.write(`${green('state layout migrated')} into the current .hh layout\n`)
    for (const step of relocated.moved)
      process.stdout.write(`  ${dim(step)}\n`)
    for (const warning of relocated.warnings)
      process.stdout.write(`  ${dim(`warning: ${warning}`)}\n`)
  }

  const files = targets(config)
  const existing = files.filter(target => fs.existsSync(target.file))
  if (existing.length === 0)
    fail(`no home-hosted state to migrate — nothing at ${globalSettingsPath} or any workspace`)

  const consented = yes || (process.env.HHOSTED_MIGRATE ?? '').toLowerCase() === 'allow'
  let stampOnly = 0

  for (const target of existing) {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(fs.readFileSync(target.file, 'utf8')) as Record<string, unknown>
    }
    catch (error) {
      fail(`cannot read ${target.file}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const meta = typeof raw.meta === 'object' && raw.meta !== null ? raw.meta as { schema?: number, writtenBy?: string } : {}
    const from = typeof meta.schema === 'number' ? meta.schema : UNSTAMPED_SCHEMA
    const plan = planConfigMigrations(from)

    if (plan.tooNew) {
      fail(`${target.file} was written by home-hosted ${meta.writtenBy ?? 'a newer release'} (config schema ${from});\n  this release understands schema ${plan.to}. Install that version, or edit the file yourself.`)
    }

    const problem = target.validate(raw)
    if (problem !== null)
      fail(`${target.file} is not a config this release can read: ${problem}`)

    if (plan.steps.length === 0) {
      const stamped = stampConfig(raw)
      if (JSON.stringify(stamped) !== JSON.stringify(raw))
        stampOnly += 1
      if (!dryRun)
        writeFileAtomic(target.file, `${JSON.stringify(stamped, null, 2)}\n`)
      continue
    }

    process.stdout.write(`migrating ${target.label}: config schema ${from} → ${plan.to}\n`)
    for (const [index, step] of plan.steps.entries())
      process.stdout.write(`  ${index + 1}. ${step.describe}\n`)

    if (dryRun)
      continue

    if (!consented) {
      if (process.stdin.isTTY !== true) {
        fail(`${target.file} needs ${plan.steps.length} migration(s) and this session cannot ask.\n  re-run with --yes, or set HHOSTED_MIGRATE=allow for unattended runs`)
      }
      const answer = await prompt(`Apply ${plan.steps.length} migration(s) to ${path.basename(target.file)}? [y/N] `)
      if (!/^yes$|^y$/i.test(answer.trim())) {
        process.stdout.write('cancelled — nothing was written\n')
        return
      }
    }

    const { config: migrated } = applyConfigMigrations(raw, from)
    const migratedProblem = target.validate(migrated)
    if (migratedProblem !== null)
      fail(`the migration produced a config this release cannot read:\n  ${migratedProblem}`)

    fs.copyFileSync(target.file, `${target.file}.bak`)
    writeFileAtomic(target.file, `${JSON.stringify(stampConfig(migrated), null, 2)}\n`)
    process.stdout.write(`${green(`migrated ${target.label} to schema ${plan.to}`)} in ${target.file}\n`)
    process.stdout.write(`  ${dim(`previous file kept at ${target.file}.bak`)}\n`)
  }

  if (dryRun) {
    process.stdout.write(`${dim('nothing was written (--dry-run)')}\n`)
    return
  }

  if (stampOnly > 0)
    process.stdout.write(`${green(`${stampOnly} file(s) stamped`)} as written by home-hosted ${appVersion()}\n`)
  else
    process.stdout.write(`every file is already what home-hosted ${appVersion()} understands — nothing to migrate\n`)
}

export const migrateCommand = defineCommand({
  meta: { name: 'migrate' },
  args: migrateArgs,
  run: async ({ args }) => {
    await runMigrate(args.config, args.dryRun === true, args.yes === true)
  },
})
