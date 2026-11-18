import type { ImportPlan } from '#src/cli/import-plan'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation } from '#src/cli/io'

/**
 * `import pm2 <file> | import compose <file>` — carry an existing setup into a workspace.
 *
 * **Plan first, write on consent.** The shape is `backup`'s: print what would be added, and write
 * only with `--confirm`. A run with no TTY and no `--confirm` exits 1, so a cron job or a CI step
 * cannot silently create servers — the rule that took a missing `--confirm` from "never took a
 * backup" to "exits 1".
 *
 * Writes go through the same path `add` uses (`addServerEntry`), so a duplicate id is the panel's
 * own `409 SERVER_EXISTS`, and through `/_hh` when the panel runs.
 */

export const importArgs = {
  'kind': { type: 'positional', required: true, description: 'pm2, or compose' },
  'file': { type: 'positional', required: true, description: 'the ecosystem file, or the compose file' },
  'workspace': { type: 'string', alias: 'w', description: 'the workspace to write into (default: the default workspace)' },
  'confirm': { type: 'boolean', description: 'write the plan (without it, nothing is written)' },
  'dry-run': { type: 'boolean', description: 'print the plan and write nothing, even with --confirm' },
  'allow-js': { type: 'boolean', description: 'evaluate a .js ecosystem file — it is code, and it runs in this process' },
  'env': { type: 'string', description: 'which pm2 env block to read: production, staging, …' },
  'id': { type: 'string', description: 'compose only: the server id (default: the directory name)' },
  'json': { type: 'boolean', description: 'print the plan as one document on stdout' },
} as const

/** Reads the file as text, refusing one that is not there. */
function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  }
  catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A pm2 ecosystem file, read without running it unless the caller said so.
 *
 * A `.js` ecosystem is **code**, so evaluating it is an explicit opt-in (`--allow-js`) and the help
 * says what it does. A `.json` one is data and is parsed. There is no third path that silently
 * `require`s someone's file because its extension looked harmless.
 */
async function readEcosystem(file: string, options: { allowJs: boolean, env?: string }): Promise<unknown[]> {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved))
    fail(`no such file: ${file}`)

  if (resolved.endsWith('.js') || resolved.endsWith('.cjs') || resolved.endsWith('.mjs')) {
    if (!options.allowJs) {
      fail(`${file} is JavaScript, and reading it means running it in this process — pass \`--allow-js\` if that is what you want, or export a JSON ecosystem file instead`)
    }
    // `import()` of an absolute path, so a `.mjs` and a `.cjs` both work; the module's `default` (or
    // `module.exports`) is the ecosystem object.
    //
    // A `.catch(fail(...))` looks tidier and is wrong: `fail()` **exits**, so it never returns a
    // value, and the guard that scans for "a refusal used where a value is expected" caught that
    // exact shape here. A `try`/`catch` says what happens and keeps the types honest.
    let loaded: unknown
    try {
      // `pathToFileURL`, not a bare path: Node's dynamic `import()` accepts a **URL**, and a Windows
      // path (`C:\Users\…`) is read as a protocol and rejected — "Only URLs with a scheme in: file,
      // data, and node are supported". Linux and macOS paths happen to work as bare specifiers, so
      // this passed on both and broke `import pm2 --allow-js` on Windows only.
      loaded = await import(pathToFileURL(resolved).href)
    }
    catch (error) {
      fail(`could not evaluate ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const value = (loaded as { default?: unknown } | null)?.default ?? loaded
    return appsOf(value, file)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readText(resolved))
  }
  catch (error) {
    fail(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return appsOf(parsed, file)
}

/** `apps[]` out of an ecosystem object, refusing a file that is not one. */
function appsOf(value: unknown, file: string): unknown[] {
  const apps = (value as { apps?: unknown } | null)?.apps
  if (!Array.isArray(apps))
    fail(`${file} has no \`apps\` array — that is what makes it a pm2 ecosystem file`)
  return apps
}

/** The plan, printed for a person: what would be added, what is refused, what cannot be carried. */
function printPlan(plan: ImportPlan, kind: 'pm2' | 'compose', workspace: string, writing: boolean): void {
  const verb = writing ? 'adding' : 'would add'
  for (const entry of plan.entries) {
    const args = Array.isArray(entry.args) ? entry.args.join(' ') : ''
    process.stdout.write(`${verb} ${bold(String(entry.id))} in ${workspace}: ${dim(`${String(entry.command)} ${args}`.trim())}\n`)
  }
  for (const warning of plan.warnings)
    process.stdout.write(`  ${dim('not carried:')} ${warning}\n`)
  for (const error of plan.errors)
    process.stdout.write(`  ${dim('refused:')} ${error}\n`)

  if (plan.entries.length === 0 && plan.errors.length === 0)
    process.stdout.write(`nothing to import from this ${kind} file\n`)
}

/**
 * Writes the plan, through the panel when it runs.
 *
 * `addServerEntry` is `add`'s own path, so a duplicate id answers `409 SERVER_EXISTS` with the same
 * sentence — and the entries are validated against the panel's schema first, so a plan this release
 * cannot store is refused before anything is written rather than halfway through.
 */
async function writePlan(plan: ImportPlan, workspace: string | undefined): Promise<{ added: string[], failed: string[] }> {
  const [{ serverCreateSchema }, { type }] = await Promise.all([import('#src/shared/contracts'), import('arktype')])
  const added: string[] = []
  const failed: string[] = []

  for (const entry of plan.entries) {
    // The whole entry, not a plan fragment: `addServerEntry` and the schema both want one.
    const checked = serverCreateSchema(entry)
    if (checked instanceof type.errors) {
      failed.push(`${String(entry.id)}: ${checked.summary}`)
      continue
    }
    try {
      const { addServerEntryOffline } = await import('#src/cli/import-write')
      await addServerEntryOffline(entry, workspace)
      added.push(String(entry.id))
    }
    catch (error) {
      failed.push(`${String(entry.id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { added, failed }
}

export const importCommand = defineCommand({
  meta: { name: 'import' },
  args: importArgs,
  async run({ args }) {
    const kind = String(args.kind ?? '').toLowerCase()
    const file = typeof args.file === 'string' ? args.file : ''
    if (kind !== 'pm2' && kind !== 'compose')
      fail(`import takes \`pm2\` or \`compose\` — \`${invocation()} import pm2 ecosystem.config.json\``)
    if (file.length === 0)
      fail(`which file? \`${invocation()} import ${kind} <file>\``)

    const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
    const { workspacesPath } = await import('#src/helpers/paths')
    const workspace = typeof args.workspace === 'string' && args.workspace.length > 0
      ? args.workspace
      : readDefaultWorkspaceId(workspacesPath)

    const plan: ImportPlan = { entries: [], warnings: [], errors: [] }
    if (kind === 'pm2') {
      const apps = await readEcosystem(file, { allowJs: args['allow-js'] === true, env: typeof args.env === 'string' ? args.env : undefined })
      const mapped = (await import('#src/cli/import-plan')).planPm2Apps(apps as never[])
      plan.entries.push(...mapped.entries)
      plan.warnings.push(...mapped.warnings)
      plan.errors.push(...mapped.errors)
    }
    else {
      const { composeEntry, looksLikeCompose } = await import('#src/cli/import-plan')
      const text = readText(file)
      // JSON and YAML both, because a compose file is YAML in every tutorial and JSON in a
      // `config --format json` export. Only the **presence of `services`** matters here: docker
      // parses the file itself at spawn, so this importer never needs a YAML parser — and adding a
      // dependency to read two fields would be the wrong trade.
      let asJson: unknown = null
      try {
        asJson = JSON.parse(text)
      }
      catch {
        // Not JSON, so it must look like a compose document in YAML: a top-level `services:` key.
      }
      const isYamlCompose = /^services:\s*$/m.test(text)
      if (!isYamlCompose && !looksLikeCompose(asJson))
        fail(`${file} has no \`services\` — that is what makes it a compose file`)
      const id = typeof args.id === 'string' && args.id.length > 0
        ? args.id
        : (await import('#src/cli/import-plan')).slugifyId(path.basename(path.dirname(path.resolve(file))))
      plan.entries.push(composeEntry(path.resolve(file), id, path.dirname(path.resolve(file))))
    }

    const writing = args.confirm === true && args['dry-run'] !== true
    if (args.json === true) {
      // One document on stdout, as `--json` promises everywhere else: the plan, and whether it was
      // written. A refusal still exits non-zero, so a script does not need to parse English.
      const result = writing ? await writePlan(plan, workspace) : { added: [], failed: [] }
      process.stdout.write(`${JSON.stringify({ kind, workspace, plan, writing, ...result })}\n`)
      if (plan.errors.length > 0 || result.failed.length > 0)
        process.exitCode = 1
      return
    }

    printPlan(plan, kind, workspace, writing)

    if (plan.errors.length > 0) {
      process.stdout.write(`\n${plan.errors.length} entr${plan.errors.length === 1 ? 'y is' : 'ies are'} refused — nothing was written for ${plan.errors.length === 1 ? 'it' : 'them'}\n`)
      process.exitCode = 1
      return
    }
    if (!writing) {
      process.stdout.write(`\n${dim(args.confirm === true ? 'nothing was written (--dry-run)' : `nothing was written — re-run with --confirm to add ${plan.entries.length === 1 ? 'it' : 'them'}`)}\n`)
      // No consent is a refusal for a script: the same rule `backup` follows.
      if (args.confirm !== true && process.stdin.isTTY !== true) {
        process.exitCode = 1
      }
      return
    }

    const result = await writePlan(plan, workspace)
    for (const id of result.added)
      process.stdout.write(`${green('added')} ${id}\n`)
    for (const line of result.failed)
      process.stdout.write(`${bold('failed')} ${line}\n`)
    if (result.failed.length > 0)
      process.exitCode = 1
    else
      process.stdout.write(`${dim('not started — `home-hosted start <id>` when you are ready')}\n`)
  },
})
