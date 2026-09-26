import type { NannyExit, NannySpec, NannyState } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { NANNY_COMMAND } from '#src/helpers/runtime'
import { processArgv } from '#src/providers/identity'
import { isProcessAlive } from '#src/providers/port'
import { processCarriesServerId } from '#src/providers/proc'
import { nannySpecSchema, nannyStateSchema } from '#src/shared/contracts'

/**
 * A persistent entry is not run by the panel: the panel spawns a *nanny* that owns
 * the child's pipes, writes its output to the entry's JSONL log and keeps a small
 * state file. That is what lets the entry survive a panel stop, restart or kill
 * without losing its log or its identity — the pipes belong to a process that stays.
 *
 * These are the files and the liveness rules behind that arrangement; the nanny
 * itself is `src/services/nanny.ts`.
 */

/** The spec carries expanded `env`, so it lives only from spawn to read. */
const SPEC_MODE = 0o600

/** Suffix of a spawn spec, so a sweep and the state reader can tell them apart. */
export const SPEC_SUFFIX = '.spec.json'

/** How often a nanny rewrites its state file. */
export const NANNY_HEARTBEAT_MS = 5000

/** A heartbeat older than this is not evidence of anything. */
const HEARTBEAT_STALE_MS = 30_000

/**
 * The state directory is passed in rather than read from a global: the panel injects
 * `$HHOSTED_HOME/.state`, and a test injects its own temp directory.
 */
export function nannySpecPath(dir: string, id: string): string {
  return path.join(dir, `${id}${SPEC_SUFFIX}`)
}

export function nannyStatePath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`)
}

/** The file a nanny writes and the panel tails; one derivation, so they cannot drift. */
export function nannyLogFile(logDir: string, id: string): string {
  return path.join(logDir, `${id}.log`)
}

/**
 * How to run this CLI again as a nanny. The panel was itself launched through this
 * entry point (`up` re-spawns itself with it), so `process.argv[1]` is the one path
 * that works under tsx, from `dist/cli.js` and through the published bin alike.
 */
export function nannyEntryPoint(): string {
  return process.argv[1] ?? ''
}

/** Written before the spawn, consumed by the nanny, never left behind. */
export function writeNannySpec(file: string, spec: NannySpec): void {
  writeFileAtomic(file, JSON.stringify(spec), { mode: SPEC_MODE })
}

export function clearNannySpec(file: string): void {
  fs.rmSync(file, { force: true })
}

/**
 * Reads and unlinks in one step: the spec holds expanded secrets, and a spec left
 * behind — a nanny that died before reading it, a panel killed mid-spawn — is a
 * secret file with no owner. It is consumed even when it cannot be parsed.
 */
export function takeNannySpec(file: string): NannySpec {
  const raw = fs.readFileSync(file, 'utf8')
  fs.rmSync(file, { force: true })

  const parsed = nannySpecSchema(JSON.parse(raw))
  if (parsed instanceof type.errors)
    throw new Error(`invalid nanny spec: ${parsed.summary}`)
  return parsed
}

/**
 * Nothing can be waiting on a spec before this panel has spawned a nanny, so every
 * one still on disk at boot belongs to a nanny that never read it.
 */
export function sweepNannySpecs(dir: string): number {
  let swept = 0
  for (const name of readSpecNames(dir)) {
    fs.rmSync(path.join(dir, name), { force: true })
    swept += 1
  }
  return swept
}

function readSpecNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith(SPEC_SUFFIX))
  }
  catch {
    return []
  }
}

/** A stale or foreign file reads as "no state", never as a throw. */
export function readNannyState(file: string): NannyState | null {
  try {
    const parsed = nannyStateSchema(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed instanceof type.errors ? null : parsed
  }
  catch {
    return null
  }
}

export function writeNannyState(file: string, state: NannyState): void {
  writeFileAtomic(file, JSON.stringify(state))
}

export function clearNannyState(file: string): void {
  fs.rmSync(file, { force: true })
}

/** The same wording the supervisor uses for a child's exit, so history reads alike. */
export function describeNannyExit(exit: NannyExit): string {
  return exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`
}

/**
 * Is the nanny this state describes still ours? A live pid proves nothing on its
 * own — pids are reused. A fresh heartbeat means a process is still rewriting the
 * file; the environment marker (Linux, macOS) or the argv we spawned it with answers
 * everywhere else, Windows included.
 */
export async function nannyIsAlive(state: NannyState, id: string): Promise<boolean> {
  if (state.nannyPid <= 0 || !isProcessAlive(state.nannyPid))
    return false
  if (Date.now() - state.heartbeatAt <= HEARTBEAT_STALE_MS)
    return true
  if (await processCarriesServerId(state.nannyPid, id))
    return true

  const words = await processArgv(state.nannyPid)
  return words !== null
    && words.includes(NANNY_COMMAND)
    && words.some(word => word.endsWith(`${id}.spec.json`))
}
