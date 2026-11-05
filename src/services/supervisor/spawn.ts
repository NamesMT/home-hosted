import type { ChildProcess } from 'node:child_process'
import type { Entry, ResolvedSpawn, SupervisorContext } from '#src/services/supervisor/entry'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { expandEnvList, expandEnvRecord, loadEnvFile, resolveEnvFilePath } from '#src/helpers/env-file'
import { projectDir } from '#src/helpers/paths'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { composeTarget } from '#src/providers/docker'
import { resolveCommand, resolveCwd } from '#src/providers/process'
import { serverTemplateVars } from '#src/providers/server-vars'
import { LineSplitter } from '#src/services/log-buffer'

/**
 * Everything `spawn` needs for an entry. The preflight recognizes the entry's own detached successor
 * by this argv too, so spawn and identification must never resolve it with two different rules.
 */
export function resolveSpawn(ctx: SupervisorContext, entry: Entry): ResolvedSpawn {
  const vars = serverTemplateVars(entry.config)
  const cwd = resolveCwd(entry.config.cwd)
  const command = resolveCommand(entry.config.command, cwd, projectDir)

  // A machine-local env file layers over the tracked config and feeds `${VAR}`, so secrets stay out of it.
  let fileEnv: Record<string, string> = {}
  if (entry.config.envFile.length > 0) {
    const file = resolveEnvFilePath(entry.config.envFile, cwd)
    const loaded = loadEnvFile(file)
    if (loaded.error !== null)
      ctx.log(entry, 'system', `env file ${file} could not be read: ${loaded.error}`)
    else if (Object.keys(loaded.env).length > 0)
      ctx.log(entry, 'system', `env file ${file} (${Object.keys(loaded.env).length} vars)`)
    fileEnv = loaded.env
  }

  const expansionVars: Record<string, string | undefined> = { ...process.env, ...fileEnv }
  const dataEnvs = resolveRecord(entry.config.dataEnvs, vars)
  const env: Record<string, string> = {
    // `envFile` is the machine-local layer, so it overrides the tracked `env`.
    ...expandEnvRecord(resolveRecord(entry.config.env, vars), expansionVars),
    ...fileEnv,
    // Data envs win: their value is the directory that gets backed up.
    ...expandEnvRecord(dataEnvs, expansionVars),
    HHOSTED_SERVER_ID: entry.config.id,
    HHOSTED_CONTROL_PORT: String(ctx.options.control.port),
  }
  // One absolute native path, so Windows never hands the process a mixed `D:\…\app/data`.
  for (const key of Object.keys(dataEnvs))
    env[key] = path.resolve(cwd, env[key]!)

  // `spawn` throws on an env key containing a NUL (from an envFile line or a JSON `\u0000`); drop the key.
  for (const key of Object.keys(env)) {
    if (!key.includes('\0'))
      continue
    delete env[key]
    ctx.log(entry, 'system', 'ignored an environment key containing a null byte')
  }

  const args = expandEnvList(resolveTemplates(entry.config.args, vars), expansionVars)

  return {
    command,
    args,
    env,
    cwd,
    // Logged *before* `${VAR}` expansion, so a secret argument never reaches logs, SSE or chat.
    loggedArgs: resolveTemplates(entry.config.args, vars),
  }
}

/**
 * Whether this entry runs a compose stack, read from what it would actually spawn. `null` is the
 * common case; a shell that happens to run docker is not detectable, and guessing would attribute a
 * stranger's containers (limits in `src/providers/docker.ts`).
 */
export function detectCompose(entry: Entry, resolved: ResolvedSpawn): void {
  entry.compose = composeTarget({ command: resolved.command, args: resolved.args, cwd: resolved.cwd, env: resolved.env })
}

export function killBootstrap(entry: Entry): void {
  try {
    entry.bootstrapChild?.kill('SIGKILL')
  }
  catch {
    // already gone
  }
}

/** Runs the entry's bootstrap, best-effort: a failure is logged and the start carries on. */
export async function runBootstrap(ctx: SupervisorContext, entry: Entry, current: () => boolean): Promise<void> {
  const spec = entry.config.bootstrap
  if (!spec || (spec.runOnce && entry.bootstrapDone))
    return

  const vars = serverTemplateVars(entry.config)
  const cwd = resolveCwd(entry.config.cwd)
  const args = resolveTemplates(spec.args, vars)
  ctx.log(entry, 'system', `bootstrap: ${spec.command} ${args.join(' ')}`)

  const splitter = new LineSplitter((_stream, text) => {
    if (text.trim().length > 0)
      ctx.log(entry, 'system', `[bootstrap] ${text}`)
  })

  // `spawn` throws synchronously for an unusable command (empty, a NUL, a cwd through a file); escaping
  // would leave the entry wedged in `starting`.
  let child: ChildProcess
  try {
    child = spawn(resolveCommand(spec.command, cwd, projectDir), args, {
      cwd,
      env: { ...process.env, ...resolveRecord(spec.env, vars) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  catch (error) {
    ctx.log(entry, 'system', `bootstrap could not start: ${(error as Error).message} — continuing anyway`)
    entry.bootstrapDone = true
    ctx.persist(entry)
    return
  }
  child.stdout?.on('data', chunk => splitter.push('stdout', chunk))
  child.stderr?.on('data', chunk => splitter.push('stderr', chunk))
  entry.bootstrapChild = child

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      ctx.log(entry, 'system', `bootstrap timed out after ${spec.timeoutMs}ms`)
      try {
        child.kill('SIGKILL')
      }
      catch {
        // already gone
      }
    }, spec.timeoutMs)
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      ctx.log(entry, 'system', `bootstrap failed: ${(error as Error).message}`)
      resolve(null)
    })
  })
  entry.bootstrapChild = null

  // Cut short by a stop: it did not finish, so a `runOnce` bootstrap is still owed.
  if (!current()) {
    ctx.log(entry, 'system', 'bootstrap stopped')
    return
  }
  entry.bootstrapDone = true
  ctx.persist(entry)
  if (code === 0)
    ctx.log(entry, 'system', 'bootstrap finished')
  else if (code !== null)
    ctx.log(entry, 'system', `bootstrap exited with code ${code} — continuing anyway`)
}
