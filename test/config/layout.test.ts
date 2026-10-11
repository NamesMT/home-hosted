import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 0.8.0 dropped the pre-workspace relocation, so a `$HHOSTED_HOME` still holding the 0.6.x
 * layout must be refused out loud. The failure this guards is silent and expensive: the new
 * stores read the absent `.hh` files as empty, seed their own defaults, and the old
 * `servers.config.json` sits unread beside a panel supervising nothing — no error anywhere.
 *
 * `paths.ts` resolves `dataRoot` at import time, so every case sets `HHOSTED_HOME` to its own
 * temp dir and re-imports the module graph — never the developer's real home.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const originalHome = process.env.HHOSTED_HOME
const dirs: string[] = []

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function freshHome(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-layout-'))
  dirs.push(dir)
  process.env.HHOSTED_HOME = dir
  return dir
}

/** A pre-workspace instance: the old files directly under `$HHOSTED_HOME`, no `.hh`. */
async function makeLegacyHome(): Promise<string> {
  const home = await freshHome()
  fs.writeFileSync(path.join(home, 'servers.config.json'), JSON.stringify({ servers: [] }, null, 2))
  fs.writeFileSync(path.join(home, '.control-secrets.json'), JSON.stringify({ password: null }, null, 2))
  return home
}

describe('ensureLayout', () => {
  it('does nothing when there is no state at all', async () => {
    await freshHome()
    const { ensureLayout } = await import('#src/config/layout')

    expect(() => ensureLayout()).not.toThrow()
  })

  it('refuses a pre-workspace home, naming the files and the fix', async () => {
    const home = await makeLegacyHome()
    const { ensureLayout } = await import('#src/config/layout')
    const { appVersion } = await import('#src/helpers/version')

    expect(() => ensureLayout()).toThrowError(/0\.6\.x/)
    try {
      ensureLayout()
    }
    catch (error) {
      const message = (error as Error).message
      expect(message).toContain(path.join(home, 'servers.config.json'))
      // The release names itself, so the message cannot go stale the way a literal would.
      expect(message).toContain(appVersion())
      expect(message).toContain('0.7.x')
      expect(message).toContain('Nothing has been changed or deleted')
    }

    // The refusal is a refusal: the only copy of the definitions is untouched.
    expect(fs.existsSync(path.join(home, 'servers.config.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.hh'))).toBe(false)
  })

  /**
   * `workspaces.json` means the layout is already current, so a stray root-level copy beside it is
   * not an old instance. Refusing on the file alone would strand a working panel — a stale root
   * `servers.config.json` is exactly what an already-migrated home can be left holding.
   */
  it('starts against a migrated home that still has a stray root config', async () => {
    const home = await makeLegacyHome()
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }, null, 2))
    const { ensureLayout } = await import('#src/config/layout')

    expect(() => ensureLayout()).not.toThrow()
  })

  it('reaches the user as one CLI error, not a stack trace', async () => {
    const home = await makeLegacyHome()
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('0.6.x')
    expect(result.stderr).toContain('0.7.x')
    expect(result.stderr, 'a stack trace names the wrong problem').not.toContain('at ensureLayout')
  })
})
