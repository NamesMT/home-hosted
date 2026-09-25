import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, prompt } from '#src/cli/io'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseConfig, stampConfig } from '#src/config/parse'
import { writeFileAtomic } from '#src/helpers/atomic'
import { defaultConfigPath } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'

/**
 * `migrate` brings `servers.config.json` up to the schema this release understands.
 *
 * Deliberately loud and deliberate: it prints every step first, backs the file up
 * before writing, refuses to write a config it cannot read, and never runs on its
 * own — a detached daemon cannot prompt, so consent comes from `--yes`, from
 * `HHOSTED_MIGRATE=allow`, or from a person at a terminal.
 */

export const migrateArgs = {
  config: { type: 'string', alias: 'c', description: 'servers config (default: <state>/servers.config.json)' },
  dryRun: { type: 'boolean', description: 'print what would change, write nothing' },
  yes: { type: 'boolean', alias: 'y', description: 'apply without asking (or set HHOSTED_MIGRATE=allow)' },
} as const

export async function runMigrate(config: string | undefined, dryRun: boolean, yes: boolean): Promise<void> {
  const file = config ?? defaultConfigPath
  if (!fs.existsSync(file))
    fail(`no config at ${file} — nothing to migrate`)

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const meta = typeof raw.meta === 'object' && raw.meta !== null ? raw.meta as { schema?: number, writtenBy?: string } : {}
  const from = typeof meta.schema === 'number' ? meta.schema : CONFIG_SCHEMA
  const plan = planConfigMigrations(from)

  if (plan.tooNew) {
    fail(`${file} was written by home-hosted ${meta.writtenBy ?? 'a newer release'} (config schema ${from});\n  this release understands schema ${plan.to}. Install that version, or edit the file yourself.`)
  }

  const stamped = stampConfig(raw)
  const upToDate = plan.steps.length === 0
  if (upToDate && !dryRun && JSON.stringify(stamped) !== JSON.stringify(raw)) {
    writeFileAtomic(file, `${JSON.stringify(stamped, null, 2)}\n`)
    process.stdout.write(`${green('config stamped')} in ${file} — written by home-hosted ${appVersion()}, schema ${plan.to}\n`)
    return
  }

  if (upToDate) {
    process.stdout.write(`config schema ${from} is already what home-hosted ${appVersion()} understands — nothing to migrate\n`)
    return
  }

  process.stdout.write(`migrating ${file}: config schema ${from} → ${plan.to}\n`)
  for (const [index, step] of plan.steps.entries())
    process.stdout.write(`  ${index + 1}. ${step.describe}\n`)

  if (dryRun) {
    process.stdout.write(`${dim(`nothing was written (--dry-run, ${plan.steps.length} step(s) pending)`)}\n`)
    return
  }

  const consented = yes || (process.env.HHOSTED_MIGRATE ?? '').toLowerCase() === 'allow'
  if (!consented) {
    if (process.stdin.isTTY !== true) {
      fail(`this config needs ${plan.steps.length} migration(s) and this session cannot ask.\n  re-run with --yes, or set HHOSTED_MIGRATE=allow for unattended runs`)
    }
    const answer = await prompt(`Apply ${plan.steps.length} migration(s) to ${path.basename(file)}? [y/N] `)
    if (!/^yes$|^y$/i.test(answer.trim())) {
      process.stdout.write('cancelled — nothing was written\n')
      return
    }
  }

  const { config: migrated, applied } = applyConfigMigrations(raw, from)
  const parsed = parseConfig(migrated)
  if (parsed.config === null) {
    fail(`the migration produced a config this release cannot read:\n  ${parsed.errors.join('\n  ')}`)
  }

  const backup = `${file}.bak`
  fs.copyFileSync(file, backup)
  writeFileAtomic(file, `${JSON.stringify(stampConfig(migrated), null, 2)}\n`)
  process.stdout.write(`${green(`migrated to schema ${plan.to}`)} (${applied.length} step(s)) in ${file}\n`)
  process.stdout.write(`  ${dim(`previous file kept at ${backup}`)}\n`)
  for (const key of parsed.unknownKeys)
    process.stdout.write(`  ${dim(`still ignoring an unrecognized key: ${key}`)}\n`)
}

export const migrateCommand = defineCommand({
  meta: { name: 'migrate', description: 'bring the config up to this release\'s schema' },
  args: migrateArgs,
  run: async ({ args }) => {
    await runMigrate(args.config, args.dryRun === true, args.yes === true)
  },
})
