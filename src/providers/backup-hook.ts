import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { BackupHookConfig, ServerConfig } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { resolveCwd } from '#src/providers/process'
import { serverTemplateVars } from '#src/services/supervisor'

/**
 * Runs one backup hook (`dump` before capture, `load` after restore).
 *
 * Same discipline as `bootstrap`: one program plus args, never a shell string, so a path with a space
 * cannot become two arguments and nothing is interpreted. Not the same code, because the failure
 * handling is the opposite — a bootstrap is best-effort and a hook is not. A `dump` that fails must
 * refuse the backup: archiving the live data directory beside a failed dump would produce an archive
 * that looks complete and is not.
 */

export interface HookResult {
  ok: boolean
  code: number | null
  /** Bounded tail of both streams, for the plan and the error. */
  output: string
  /** Set when the process could not be started or timed out. */
  error?: string
}

/** Output kept for the error message and the plan; the rest is dropped rather than buffered. */
const OUTPUT_TAIL_BYTES = 8 * 1024

function tail(previous: string, chunk: string): string {
  const next = previous + chunk
  return next.length <= OUTPUT_TAIL_BYTES ? next : next.slice(next.length - OUTPUT_TAIL_BYTES)
}

/**
 * Run a hook for one entry.
 *
 * `dumpDir` is passed in rather than templated by the caller so the same absolute path can be handed
 * to `dump` and later to `load`, which is what makes the pair symmetric.
 */
export async function runBackupHook(
  hook: BackupHookConfig,
  server: ServerConfig,
  dumpDir: string,
  options: { requireDumpDir?: boolean } = {},
): Promise<HookResult> {
  const vars = { ...serverTemplateVars(server), dumpDir }
  const cwd = resolveCwd(server.cwd)
  const args = resolveTemplates(hook.args, vars)

  // A hook that names `{dumpDir}` must be given a directory that exists, or `mongodump` creates a
  // file at a path whose parent is missing and fails with a much less useful message.
  if (options.requireDumpDir !== false)
    fs.mkdirSync(dumpDir, { recursive: true })

  let child: ChildProcess
  try {
    // `shell: false` is the default: the command is a program, never a command line.
    child = spawn(hook.command, args, {
      cwd,
      env: { ...process.env, ...resolveRecord(hook.env, vars) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  catch (error) {
    return { ok: false, code: null, output: '', error: `could not start: ${(error as Error).message}` }
  }

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output = tail(output, chunk.toString())
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output = tail(output, chunk.toString())
  })

  const outcome = await new Promise<{ code: number | null, error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      }
      catch {
        // already gone
      }
      resolve({ code: null, error: `timed out after ${hook.timeoutMs}ms` })
    }, hook.timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, error: error.message })
    })
  })

  return {
    ok: outcome.error === undefined && outcome.code === 0,
    code: outcome.code,
    output,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  }
}

/**
 * The line a person reads when a hook fails.
 *
 * Names the entry, the program and the last thing it said — a bare "the backup failed" would send
 * them to the panel's log to find out which of five databases refused.
 */
export function hookFailure(action: 'dump' | 'load', server: ServerConfig, result: HookResult): string {
  const detail = result.error ?? (result.code === null ? 'no exit code' : `exit ${result.code}`)
  const said = result.output.trim().split('\n').filter(line => line.trim().length > 0).slice(-3).join(' / ')
  return `the ${action} hook for "${server.id}" failed (${detail})${said.length === 0 ? '' : `: ${said}`}`
}
