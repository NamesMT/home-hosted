import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `migrate` asks once, and a "no" writes nothing.
 *
 * It used to plan, ask and write file by file: restamps and earlier lifts were already on disk
 * (with their `.bak`) when a later "n" printed "cancelled — nothing was written". In-process, because
 * the prompt needs a terminal a spawned child does not have.
 */
const originalHome = process.env.HHOSTED_HOME
const originalTty = process.stdin.isTTY
const dirs: string[] = []

afterEach(() => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  process.stdin.isTTY = originalTty
  vi.doUnmock('#src/cli/io')
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function homeWithTwoLifts(): { home: string, files: Record<string, string> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-consent-'))
  dirs.push(home)
  const hh = path.join(home, '.hh')
  const stamp = { writtenBy: '0.7.21', schema: 1 }
  const files: Record<string, string> = {}
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    files[file] = `${JSON.stringify(value, null, 2)}\n`
    fs.writeFileSync(file, files[file]!)
  }
  write(path.join(hh, 'workspaces.json'), { workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }] })
  // A restamp, planned first …
  write(path.join(hh, 'settings.json'), { meta: stamp, control: { port: 4100 } })
  for (const id of ['default', 'staging']) {
    // … then two files with a schema step each.
    write(path.join(hh, id, 'settings.json'), { meta: stamp, notifications: { telegram: { enabled: false, chatId: '' } } })
    write(path.join(hh, id, 'servers.config.json'), { meta: stamp, servers: [] })
  }
  return { home, files }
}

describe('migrate consent', () => {
  it('asks once for every schema step, and a "no" leaves every file as it was', async () => {
    const { home, files } = homeWithTwoLifts()
    process.env.HHOSTED_HOME = home
    process.stdin.isTTY = true
    vi.resetModules()
    const questions: string[] = []
    vi.doMock('#src/cli/io', async importOriginal => ({
      ...await importOriginal<typeof import('#src/cli/io')>(),
      prompt: async (question: string) => {
        questions.push(question)
        return 'n'
      },
    }))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { runMigrate } = await import('#src/cli/migrate')

    await runMigrate(false, false)

    expect(questions).toEqual(['Apply 2 migration(s) to 2 file(s)? [y/N] '])
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('cancelled — nothing was written')
    for (const [file, text] of Object.entries(files)) {
      expect(fs.readFileSync(file, 'utf8'), file).toBe(text)
      expect(fs.existsSync(`${file}.bak`), `${file}.bak`).toBe(false)
    }
  })
})
