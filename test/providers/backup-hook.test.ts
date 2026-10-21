import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { parseServersFile } from '#src/config/parse'
import { hookFailure, runBackupHook } from '#src/providers/backup-hook'

/**
 * A `dump` hook is what makes a database backup consistent, so its failure has to be loud: an
 * archive that looks complete and is not is worse than no archive at all.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-hook-'))
  dirs.push(dir)
  return dir
}

/** A parsed entry, so the template vars get the defaults a real config has. */
function server(hook: Record<string, unknown>): ReturnType<typeof parseServersFile>['servers'][number] {
  // Stamped with this release's schema: an unstamped config is read as the oldest layout and refused
  // with "needs N migrations", which would make every assertion below meaningless.
  const parsed = parseServersFile({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [{ id: 'db', command: 'node', ...hook }] }, {})
  return parsed.servers[0]!
}

describe('the backup hook runner', () => {
  it('resolves {dumpDir} and reports success', async () => {
    const dir = makeDir()
    const dumpDir = path.join(dir, 'dump')
    const entry = server({
      dump: { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/x", "OK")', '{dumpDir}'] },
    })

    const result = await runBackupHook(entry.dump!, entry, dumpDir)
    expect(result.ok, result.output).toBe(true)
    // The directory is created before the hook runs, so `mongodump` never has to make it.
    expect(fs.readFileSync(path.join(dumpDir, 'x'), 'utf8')).toBe('OK')
  })

  it('refuses a non-zero exit', async () => {
    const entry = server({ dump: { command: process.execPath, args: ['-e', 'process.exit(3)'] } })
    const result = await runBackupHook(entry.dump!, entry, path.join(makeDir(), 'dump'))
    expect(result.ok).toBe(false)
    expect(result.code).toBe(3)
  })

  it('refuses a command that cannot be started', async () => {
    const entry = server({ dump: { command: 'home-hosted-no-such-binary', args: [] } })
    const result = await runBackupHook(entry.dump!, entry, path.join(makeDir(), 'dump'))
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('keeps the tail of what the hook said, and names it in the failure', async () => {
    const entry = server({ dump: { command: process.execPath, args: ['-e', 'console.error("auth failed for user blog"); process.exit(1)'] } })
    const result = await runBackupHook(entry.dump!, entry, path.join(makeDir(), 'dump'))
    expect(result.ok).toBe(false)
    expect(hookFailure('dump', entry, result)).toContain('auth failed')
    // The entry is named, because "the backup failed" alone sends someone to the log to find out which.
    expect(hookFailure('dump', entry, result)).toContain('"db"')
  })

  it('honours the timeout instead of hanging the backup forever', async () => {
    const entry = server({ dump: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000 } })
    const result = await runBackupHook(entry.dump!, entry, path.join(makeDir(), 'dump'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
  })
})
