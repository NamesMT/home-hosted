import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '#src/config/store'
import { configJson } from '../support/config-fixture'

/**
 * The decoder has its own suite; this is the seam that made the defect reach a person.
 *
 * `WorkspaceStore` is what `up` reads a workspace through, so a BOM on a hand-edited
 * `servers.config.json` was refused here with *"cannot parse … Unexpected token '\uFEFF'"*.
 * The helper alone passing would not prove the reader uses it — a new `fs.readFileSync(file,
 * 'utf8')` in the store reopens the defect with every helper test still green.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bom-store-'))
  dirs.push(dir)
  return dir
}

/** What PowerShell 5.1's `Set-Content -Encoding UTF8` and Notepad's BOM save produce. */
function withUtf8Bom(text: string): string {
  return `\uFEFF${text}`
}

function storeWith(serversText: string, settingsText?: string) {
  const dir = scratch()
  const servers = path.join(dir, 'servers.config.json')
  fs.writeFileSync(servers, serversText)
  const settings = path.join(dir, 'settings.json')
  if (settingsText !== undefined)
    fs.writeFileSync(settings, settingsText)
  const store = new WorkspaceStore('default', settings, servers)
  store.load()
  return store
}

describe('a config saved by a Windows editor', () => {
  it('loads a servers file that carries a byte-order mark', () => {
    const store = storeWith(withUtf8Bom(configJson({ servers: [{ id: 'app', command: 'node' }] })))

    // Anti-vacuity: the exact failure was a parse error, so assert the file was read.
    expect(store.configError, 'a BOM must not read as broken JSON').toBeNull()
    expect(store.servers.map(server => server.id)).toEqual(['app'])
  })

  it('loads a workspace settings file that carries a byte-order mark', () => {
    const store = storeWith(
      configJson({ servers: [] }),
      withUtf8Bom(configJson({ logs: { keep: 7 } })),
    )

    expect(store.configError).toBeNull()
    expect(store.config.logs.keep).toBe(7)
  })

  it('still reports genuinely unparseable JSON, so the mark is not a blanket rescue', () => {
    const store = storeWith(withUtf8Bom('{ "servers": [ }'))

    expect(store.configError).toContain('cannot parse')
  })

  it('keeps the running config when a BOM\'d edit is broken, as it does for any bad edit', () => {
    // The same file, reloaded from disk with the servers list replaced by a syntax error:
    // the panel must keep what it has and report the error, never fall back to the seed.
    const dir = scratch()
    const servers = path.join(dir, 'servers.config.json')
    fs.writeFileSync(servers, configJson({ servers: [{ id: 'app', command: 'node' }] }))
    const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), servers)
    store.load()
    expect(store.servers.map(server => server.id)).toEqual(['app'])

    fs.writeFileSync(servers, withUtf8Bom('{ "servers": [ }'))
    const reloaded = store.reloadFromDisk()

    expect(reloaded.error).toContain('cannot parse')
    expect(store.servers.map(server => server.id), 'a broken edit must not disturb the running config').toEqual(['app'])
  })
})
