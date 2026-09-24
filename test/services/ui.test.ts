import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterEach, describe, expect, it } from 'vitest'
import { isSafeUiEntry, UiService } from '#src/services/ui'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeZip(file: string, entries: Record<string, string>): Promise<string> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new Uint8ArrayReader(Buffer.from(content)))
  fs.writeFileSync(file, await writer.close())
  return file
}

async function makeFixture(): Promise<{ ui: UiService, root: string, stock: string, zip: (entries: Record<string, string>) => Promise<string> }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-ui-'))
  dirs.push(root)

  const stock = path.join(root, 'stock')
  fs.mkdirSync(stock, { recursive: true })
  fs.writeFileSync(path.join(stock, 'index.html'), '<!doctype html><title>stock</title>')

  const ui = new UiService({ dataRoot: root, stockDir: stock })
  let sequence = 0
  return {
    ui,
    root,
    stock,
    zip: entries => makeZip(path.join(root, `ui-${sequence++}.zip`), entries),
  }
}

describe('isSafeUiEntry', () => {
  it('accepts site files and rejects anything that could escape', () => {
    for (const name of ['index.html', 'assets/app-1a2b.js', './nested/deep/file.css', 'ui.json'])
      expect(isSafeUiEntry(name), name).toBe(true)

    for (const name of ['/etc/passwd', '../outside.html', 'assets/../../x', 'C:\\evil', 'a\\b', '', './', 'x'.repeat(140)])
      expect(isSafeUiEntry(name), name).toBe(false)
  })
})

describe('ui service', () => {
  it('serves the stock UI until one is installed', async () => {
    const fixture = await makeFixture()

    expect(fixture.ui.custom).toBe(false)
    expect(fixture.ui.resolveDir()).toBe(fixture.stock)
    expect(fixture.ui.status()).toMatchObject({ custom: false, meta: null })
    expect(fixture.ui.revert()).toBe(false)
  })

  it('installs an uploaded UI and serves it until it is reverted', async () => {
    const fixture = await makeFixture()
    const archive = await fixture.zip({
      'index.html': '<!doctype html><title>mine</title>',
      'assets/app.js': 'console.log(1)',
      'ui.json': JSON.stringify({ name: 'my-panel', version: '2.1.0' }),
    })

    const result = await fixture.ui.install(archive, 'from-upload')
    expect(result.ok).toBe(true)
    expect(result.ok && result.meta).toMatchObject({ name: 'my-panel', version: '2.1.0', files: 2 })

    expect(fixture.ui.custom).toBe(true)
    expect(fixture.ui.resolveDir()).toBe(fixture.ui.directory)
    expect(fs.readFileSync(path.join(fixture.ui.directory, 'index.html'), 'utf8')).toContain('mine')
    expect(fixture.ui.status()).toMatchObject({ custom: true, meta: { name: 'my-panel' } })

    expect(fixture.ui.revert()).toBe(true)
    expect(fixture.ui.custom).toBe(false)
    expect(fixture.ui.resolveDir()).toBe(fixture.stock)
    expect(fs.existsSync(fixture.ui.directory)).toBe(false)
  })

  it('finds the site inside a single wrapper directory', async () => {
    const fixture = await makeFixture()
    const archive = await fixture.zip({
      'dist/index.html': '<!doctype html><title>wrapped</title>',
      'dist/assets/app.js': 'x',
    })

    const result = await fixture.ui.install(archive)
    expect(result.ok).toBe(true)
    expect(result.ok && result.meta.name).toBe('custom-ui')
    expect(fs.readFileSync(path.join(fixture.ui.directory, 'index.html'), 'utf8')).toContain('wrapped')
  })

  it('refuses an archive without an index.html, and leaves the stock UI serving', async () => {
    const fixture = await makeFixture()
    const archive = await fixture.zip({ 'assets/app.js': 'x' })

    const result = await fixture.ui.install(archive)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.error).toContain('index.html')
    expect(fixture.ui.resolveDir()).toBe(fixture.stock)
  })

  it('refuses a traversal attempt and anything that is not a zip', async () => {
    const fixture = await makeFixture()

    // Either the reader refuses the name outright, or our allowlist does.
    const escape = await fixture.zip({ '../escape.html': 'x' })
    const escaped = await fixture.ui.install(escape)
    expect(escaped.ok).toBe(false)
    expect(fs.existsSync(path.join(fixture.root, 'escape.html'))).toBe(false)
    expect(fixture.ui.custom).toBe(false)

    expect((await fixture.ui.install(path.join(fixture.root, 'missing.zip'))).ok).toBe(false)

    const junk = path.join(fixture.root, 'junk.zip')
    fs.writeFileSync(junk, 'not a zip')
    const result = await fixture.ui.install(junk)
    expect(result).toEqual({ ok: false, error: 'the upload is not a zip archive' })
  })

  it('keeps the installed UI when a later upload fails', async () => {
    const fixture = await makeFixture()
    const good = await fixture.zip({ 'index.html': '<title>good</title>' })
    expect((await fixture.ui.install(good, 'good')).ok).toBe(true)

    const bad = await fixture.zip({ 'readme.txt': 'no index' })
    expect((await fixture.ui.install(bad)).ok).toBe(false)
    expect(fixture.ui.custom).toBe(true)
    expect(fs.readFileSync(path.join(fixture.ui.directory, 'index.html'), 'utf8')).toContain('good')
  })
})
