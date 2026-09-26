import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { impliedAsset, planUiUpdate, usableCandidates } from '#src/cli/ui-update'
import { logger } from '#src/helpers/logger'
import { appVersion } from '#src/helpers/version'
import { UiService } from '#src/services/ui'
import { autoUpdateOfficialUi, officialTagFor, syncOfficialUi } from '#src/services/ui-update'

const official = { name: 'noc-console', version: '1.0.0', repo: 'NamesMT/home-hosted', tag: 'v0.6.0', asset: 'home-hosted-ui-noc-console.zip', unix: 1790366625 }
const foreign = { name: 'my-ui', version: '2.3.0', repo: 'someone/their-ui', tag: 'v2.3.0', asset: 'my-ui.zip', unix: null }

describe('planUiUpdate', () => {
  it('does nothing at all for the stock UI, which ships with the panel', () => {
    expect(planUiUpdate(null, 'v0.7.0')).toEqual({ kind: 'stock' })
  })

  it('pairs our own UI with this panel\'s release, whoever built the panel', () => {
    const plan = planUiUpdate(official, 'v0.7.0')
    expect(plan.kind).toBe('official')
    expect(plan).toMatchObject({ target: 'v0.7.0' })
  })

  it('has nothing to offer when the UI never said where it came from', () => {
    const plan = planUiUpdate({ ...official, repo: null }, 'v0.7.0')
    expect(plan.kind).toBe('unidentifiable')
  })

  it('offers the releases of someone else\'s UI instead of deciding', () => {
    const releases = [
      { tag: 'v2.4.0', assets: [{ name: 'my-ui.zip' }] },
      { tag: 'v2.3.0', assets: [{ name: 'my-ui.zip' }] },
      { tag: 'v2.5.0', assets: [{ name: 'other-ui.zip' }] },
    ]
    const plan = planUiUpdate(foreign, 'v0.7.0', releases)
    expect(plan.kind).toBe('choice')
    expect(plan).toMatchObject({ asset: 'my-ui.zip', candidates: [{ tag: 'v2.4.0', asset: 'my-ui.zip' }] })
  })

  it('is unidentifiable when not even the name is known', () => {
    const plan = planUiUpdate({ ...foreign, name: '', asset: null }, 'v0.7.0')
    expect(plan.kind).toBe('unidentifiable')
  })
})

describe('usableCandidates', () => {
  const releases = [
    { tag: 'v3.0.0', assets: [{ name: 'ui.zip' }, { name: 'notes.txt' }] },
    { tag: 'v2.0.0', assets: [{ name: 'ui.zip' }] },
    { tag: 'v1.0.0', assets: [{ name: 'ui.zip' }] },
    { tag: 'v0.9.0', assets: [{ name: 'other.zip' }] },
  ]

  it('lists only releases carrying the asset in use, newer than the installed tag', () => {
    expect(usableCandidates(releases, 'ui.zip', 'newer', 'v2.0.0')).toEqual([{ tag: 'v3.0.0', asset: 'ui.zip' }])
  })

  it('lists older releases under --old, and never the installed one', () => {
    expect(usableCandidates(releases, 'ui.zip', 'older', 'v2.0.0')).toEqual([{ tag: 'v1.0.0', asset: 'ui.zip' }])
  })

  it('skips a release that does not carry the asset at all', () => {
    const found = usableCandidates(releases, 'ui.zip', 'newer', null)
    expect(found.map(entry => entry.tag)).toEqual(['v3.0.0', 'v2.0.0', 'v1.0.0'])
  })

  it('matches the asset by unambiguous substring, as ui-switch does', () => {
    expect(usableCandidates([{ tag: 'v9.0.0', assets: [{ name: 'home-hosted-ui-thing.zip' }] }], 'thing', 'newer', null))
      .toEqual([{ tag: 'v9.0.0', asset: 'home-hosted-ui-thing.zip' }])
  })

  it('offers nothing when the installed tag is the newest release', () => {
    expect(usableCandidates(releases, 'ui.zip', 'newer', 'v3.0.0')).toEqual([])
  })
})

describe('impliedAsset', () => {
  it('uses the declared asset when there is one', () => {
    expect(impliedAsset(foreign)).toBe('my-ui.zip')
  })

  it('falls back to the UI name when the archive declared no asset', () => {
    expect(impliedAsset({ ...foreign, asset: null })).toBe('my-ui.zip')
  })

  it('has nothing to imply without either', () => {
    expect(impliedAsset({ ...foreign, name: '', asset: '' })).toBeNull()
  })
})

describe('officialTagFor', () => {
  it('pairs our own repo with this panel version', () => {
    expect(officialTagFor(official, '1.2.3')).toEqual({ tag: 'v1.2.3', repo: 'NamesMT/home-hosted' })
  })

  it('leaves another repo, and a missing or malformed repo, alone', () => {
    expect(officialTagFor(foreign, '1.2.3')).toBeNull()
    expect(officialTagFor({ tag: 'v1.0.0' }, '1.2.3')).toBeNull()
    expect(officialTagFor({ repo: 'not a slug' }, '1.2.3')).toBeNull()
    expect(officialTagFor(null, '1.2.3')).toBeNull()
  })
})

/**
 * `syncOfficialUi` is the one unattended install: it runs at startup, so every
 * outcome is a value rather than a throw. A real `UiService` over a temp home
 * and a real zip, with `fetch` stubbed — this must never reach GitHub.
 */

const dirs: string[] = []
/** Temp dirs `downloadToTemp` asked the fs for, so cleanup can be proved. */
const downloadDirs: string[] = []
const realMkdtemp = fs.promises.mkdtemp

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A zip holding one real UI, as `UiService` requires (an `index.html` at the root). */
async function uiZip(name = 'official-ui.zip'): Promise<string> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add('index.html', new Uint8ArrayReader(Buffer.from('<!doctype html><title>official</title>')))
  const file = path.join(tempDir('hh-uizip-'), name)
  fs.writeFileSync(file, await writer.close())
  return file
}

/** A home with a custom UI already installed, described by `ui.json` when given one. */
function homeWith(meta?: Record<string, unknown> | 'unreadable'): string {
  const root = tempDir('hh-ui-home-')
  fs.mkdirSync(path.join(root, '.ui'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ui', 'index.html'), '<!doctype html><title>old</title>')
  if (meta !== undefined)
    fs.writeFileSync(path.join(root, '.ui', 'ui.json'), meta === 'unreadable' ? '{' : JSON.stringify(meta))
  return root
}

const uiAt = (root: string): UiService => new UiService({ dataRoot: root })
function installedMeta(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, '.ui', 'ui.json'), 'utf8')) as Record<string, unknown>
}

/** The official release for `tag`, carrying `assets`, plus a real zip for the download. */
async function stubRelease(
  tag: string,
  assets: Array<{ name: string, url: string }>,
  options: { status?: number, archive?: 'zip' | 'garbage' } = {},
): Promise<Array<{ url: string, init: RequestInit | undefined }>> {
  const archive = options.archive === 'garbage'
    ? Buffer.from('this is not a zip')
    : fs.readFileSync(await uiZip(assets[0]?.name ?? 'official-ui.zip'))
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/releases/'))
      return new Response(JSON.stringify({ tag_name: tag, assets }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } })
    return new Response(archive, { status: 200 })
  })
  return calls
}

const OWN_REPO = 'NamesMT/home-hosted'

/** The headers a stub call was made with, lower-cased as `fetch` would send them. */
function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

beforeEach(() => {
  // The wrapper only records what `downloadToTemp` asked the fs for.
  const recordingMkdtemp = async (prefix: string, options?: BufferEncoding): Promise<string> => {
    const dir = await realMkdtemp(prefix, options)
    dirs.push(dir)
    if (typeof prefix === 'string' && prefix.startsWith('hh-ui-'))
      downloadDirs.push(dir)
    return dir
  }
  fs.promises.mkdtemp = recordingMkdtemp as typeof fs.promises.mkdtemp
})

afterEach(async () => {
  fs.promises.mkdtemp = realMkdtemp
  vi.unstubAllGlobals()
  downloadDirs.length = 0
  for (const dir of dirs.splice(0))
    await fs.promises.rm(dir, { recursive: true, force: true })
})

describe('syncOfficialUi', () => {
  it('leaves the stock UI alone without looking anything up', async () => {
    const root = tempDir('hh-ui-home-')
    const calls = await stubRelease('v9.9.9', [])

    await expect(syncOfficialUi(uiAt(root), '1.2.3')).resolves.toEqual({ kind: 'not-custom' })
    expect(calls).toEqual([])
  })

  it('has no identity to work from without a readable ui.json', async () => {
    const calls = await stubRelease('v9.9.9', [])

    await expect(syncOfficialUi(uiAt(homeWith()), '1.2.3')).resolves.toEqual({ kind: 'no-identity' })
    await expect(syncOfficialUi(uiAt(homeWith('unreadable')), '1.2.3')).resolves.toEqual({ kind: 'no-identity' })
    await expect(syncOfficialUi(uiAt(homeWith({ name: 'mine' })), '1.2.3')).resolves.toEqual({ kind: 'no-identity' })
    await expect(syncOfficialUi(uiAt(homeWith({ repo: 'not a slug' })), '1.2.3')).resolves.toEqual({ kind: 'no-identity' })
    expect(calls).toEqual([])
  })

  it('never guesses at someone else\'s UI, however new its release looks', async () => {
    const root = homeWith({ name: 'my-ui', repo: 'someone/their-ui', tag: 'v1.0.0' })
    const calls = await stubRelease('v9.9.9', [])

    await expect(syncOfficialUi(uiAt(root), '1.2.3')).resolves.toEqual({ kind: 'foreign' })
    expect(calls).toEqual([])
    expect(installedMeta(root).tag).toBe('v1.0.0')
  })

  it('does nothing when the UI already came from this panel\'s release', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: `v${appVersion()}`, asset: 'ui.zip' })
    const calls = await stubRelease('v9.9.9', [])

    // No `runningVersion`: this one pins the default, which is the panel's own version.
    await expect(syncOfficialUi(uiAt(root))).resolves.toEqual({ kind: 'current', tag: `v${appVersion()}` })
    expect(calls).toEqual([])
  })

  it('installs this panel\'s release, by its own tag, over the old UI', async () => {
    const root = homeWith({ name: 'noc-console', version: '1.0.0', repo: OWN_REPO, tag: 'v1.0.0', asset: 'home-hosted-ui-noc-console.zip' })
    const calls = await stubRelease('v1.2.3', [{ name: 'home-hosted-ui-noc-console.zip', url: 'https://api.github.com/asset/1' }])

    await expect(syncOfficialUi(uiAt(root), '1.2.3')).resolves.toEqual({ kind: 'updated', tag: 'v1.2.3' })

    expect(calls[0]!.url).toBe(`https://api.github.com/repos/${OWN_REPO}/releases/tags/v1.2.3`)
    expect(calls[1]!.url).toBe('https://api.github.com/asset/1')
    expect(requestHeaders(calls[1]!.init).accept).toBe('application/octet-stream')
    expect(requestHeaders(calls[1]!.init)['user-agent']).toBe('home-hosted/1.2.3')

    // The tag is the release it just fetched, and the archive is really in place.
    expect(installedMeta(root).tag).toBe('v1.2.3')
    expect(fs.readFileSync(path.join(root, '.ui', 'index.html'), 'utf8')).toContain('official')
    // The temp directory the download used is gone.
    expect(downloadDirs.filter(dir => fs.existsSync(dir))).toEqual([])
  })

  it('takes the only UI asset when the archive never named one', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0' })
    const calls = await stubRelease('v1.2.3', [
      // An asset entry with no name at all is skipped, not a crash.
      { name: undefined as unknown as string, url: 'https://api.github.com/asset/nameless' },
      { name: 'SHA256SUMS', url: 'https://api.github.com/asset/sums' },
      { name: 'home-hosted-ui-noc-console.zip', url: 'https://api.github.com/asset/1' },
    ])

    // A release with exactly one .zip still installs: the checksum file is not a candidate.
    await expect(syncOfficialUi(uiAt(root), '1.2.3')).resolves.toEqual({ kind: 'updated', tag: 'v1.2.3' })
    expect(calls[1]!.url).toBe('https://api.github.com/asset/1')
  })

  it('sends the token from the environment, so an unattended call is not rate-limited', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    const calls = await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }])

    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'gh-fallback'
    try {
      await syncOfficialUi(uiAt(root), '1.2.3')
      expect(requestHeaders(calls[0]!.init).authorization).toBe('Bearer gh-fallback')
    }
    finally {
      delete process.env.GH_TOKEN
    }
  })

  it('still reports a failure that is not an Error at all', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }])

    // A bare string out of `install`: the seam is all `UiService` needs to be.
    const boom: unknown = 'the disk went away'
    const throwing = {
      custom: true,
      readMeta: () => ({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' }),
      install: async () => { throw boom },
    } as unknown as UiService

    await expect(syncOfficialUi(throwing, '1.2.3')).resolves.toEqual({ kind: 'failed', error: 'the disk went away' })
    expect(root).toBeTruthy()
  })

  it('reports every failure as a value, and leaves the old UI serving', async () => {
    const noAsset = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'SHA256SUMS', url: 'https://api.github.com/asset/sums' }])
    await expect(syncOfficialUi(uiAt(noAsset), '1.2.3'))
      .resolves
      .toEqual({ kind: 'failed', error: 'no UI asset in NamesMT/home-hosted@v1.2.3' })
    expect(installedMeta(noAsset).tag).toBe('v1.0.0')

    const wrongName = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ghost.zip' })
    await stubRelease('v1.2.3', [{ name: 'home-hosted-ui-stock.zip', url: 'https://api.github.com/asset/1' }])
    const unmatched = await syncOfficialUi(uiAt(wrongName), '1.2.3')
    expect(unmatched).toMatchObject({ kind: 'failed' })
    expect(unmatched.kind === 'failed' && unmatched.error).toContain('no asset matches "ghost.zip"')
    expect(installedMeta(wrongName).tag).toBe('v1.0.0')

    const badArchive = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }], { archive: 'garbage' })
    await expect(syncOfficialUi(uiAt(badArchive), '1.2.3'))
      .resolves
      .toEqual({ kind: 'failed', error: 'the upload is not a zip archive' })
    expect(fs.readFileSync(path.join(badArchive, '.ui', 'index.html'), 'utf8')).toContain('old')
    // Even a failed install cleans up after itself.
    expect(downloadDirs.filter(dir => fs.existsSync(dir))).toEqual([])

    const unreachable = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed') })
    const offline = await syncOfficialUi(uiAt(unreachable), '1.2.3')
    expect(offline).toMatchObject({ kind: 'failed' })
    expect(offline.kind === 'failed' && offline.error).toContain('could not reach GitHub')

    const missingRelease = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    const calls = await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }], { status: 404 })
    const notFound = await syncOfficialUi(uiAt(missingRelease), '1.2.3')
    expect(notFound).toMatchObject({ kind: 'failed' })
    expect(notFound.kind === 'failed' && notFound.error).toContain('no release tagged "v1.2.3"')
    expect(calls).toHaveLength(1)
  })
})

describe('autoUpdateOfficialUi', () => {
  const lines: string[] = []
  let savedInfo: typeof logger.info
  let savedWarn: typeof logger.warn

  beforeEach(() => {
    lines.length = 0
    savedInfo = logger.info
    savedWarn = logger.warn
    logger.info = ((...args: unknown[]) => { lines.push(String(args[0])) }) as typeof logger.info
    logger.warn = ((...args: unknown[]) => { lines.push(String(args[0])) }) as typeof logger.warn
  })

  afterEach(() => {
    logger.info = savedInfo
    logger.warn = savedWarn
  })

  /** The hook is fire-and-forget, so wait for the log line rather than guess a delay. */
  async function waitForLines(count: number): Promise<void> {
    for (let attempt = 0; attempt < 400 && lines.length < count; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5))
    expect(lines.length, JSON.stringify(lines)).toBeGreaterThanOrEqual(count)
  }

  it('says nothing at all when there is no custom UI to pair', async () => {
    const calls = await stubRelease('v9.9.9', [])
    const root = tempDir('hh-ui-home-')

    autoUpdateOfficialUi(uiAt(root), '1.2.3')
    autoUpdateOfficialUi(uiAt(homeWith({ name: 'mine', repo: 'someone/their-ui', tag: 'v1.0.0' })), '1.2.3')
    autoUpdateOfficialUi(uiAt(homeWith({ name: 'mine', repo: OWN_REPO, tag: 'v1.2.3' })), '1.2.3')
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(lines).toEqual([])
    expect(calls).toEqual([])
  })

  it('updates a stale official UI and logs both ends of it', async () => {
    const root = homeWith({ repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }])

    autoUpdateOfficialUi(uiAt(root), '1.2.3')
    await waitForLines(2)

    expect(lines[0]).toContain('custom UI  came from v1.0.0; this panel is v1.2.3 — updating')
    expect(lines[1]).toBe('ui:      updated to v1.2.3 — refresh the browser')
    expect(installedMeta(root).tag).toBe('v1.2.3')
  })

  it('says an unknown release when the archive recorded no tag', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }])

    autoUpdateOfficialUi(uiAt(root), '1.2.3')
    await waitForLines(2)
    expect(lines[0]).toContain('came from an unknown release; this panel is v1.2.3 — updating')
    expect(installedMeta(root).tag).toBe('v1.2.3')
  })

  it('names the UI and its version when the archive declared them', async () => {
    const root = homeWith({ name: 'noc-console', version: '1.0.0', repo: OWN_REPO, tag: 'v1.0.0' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }])

    autoUpdateOfficialUi(uiAt(root), '1.2.3')
    // Both lines, so the background install has settled before the temp home is removed.
    await waitForLines(2)
    expect(lines[0]).toContain('noc-console 1.0.0 came from v1.0.0')
  })

  it('reports a UI it never got, and never throws at the caller', async () => {
    const root = homeWith({ name: 'noc-console', repo: OWN_REPO, tag: 'v1.0.0', asset: 'ui.zip' })
    await stubRelease('v1.2.3', [{ name: 'ui.zip', url: 'https://api.github.com/asset/1' }], { status: 404 })

    expect(() => autoUpdateOfficialUi(uiAt(root), '1.2.3')).not.toThrow()
    await waitForLines(2)
    expect(lines[1]).toContain('could not update to v1.2.3: no release tagged "v1.2.3"')
    expect(installedMeta(root).tag).toBe('v1.0.0')
  })
})
