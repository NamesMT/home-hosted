import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REPO,
  defaultReleaseTag,
  fallbackUiName,
  isGithubHost,
  isOwnRepo,
  isUiAsset,
  matchAsset,
  noAssetsMessage,
  parseFileSource,
  parseRepoSlug,
  releaseApiUrl,
} from '#src/cli/ui-switch'

/**
 * `uiSwitch` end to end, off the network: a real minimal UI zip on disk (built the same
 * way `test/services/ui.test.ts` builds one), a recording `io` seam in place of a
 * terminal, and `fetch` stubbed with real `Response` objects.
 */

const dirs: string[] = []
/** Temp dirs `downloadToTemp` asked the fs for, so a test can prove it cleaned them up. */
const downloadDirs: string[] = []
const realMkdtemp = fs.promises.mkdtemp

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** The `HHOSTED_HOME` a `uiSwitch` install lands in — never the real one. */
let home: string
let savedHome: string | undefined
const savedTokens: { GITHUB_TOKEN?: string, GH_TOKEN?: string } = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN }

/**
 * `uiSwitch` reaches the state directory through `dataRoot`, which `src/helpers/paths.ts`
 * resolves when it is first imported. The temp `HHOSTED_HOME` is set in `beforeEach`, so
 * the module is imported lazily, inside the test that runs.
 */
async function runSwitch(
  argv: string[],
  io: Parameters<typeof import('#src/cli/ui-switch').uiSwitch>[1],
): Promise<void> {
  const { uiSwitch } = await import('#src/cli/ui-switch')
  await uiSwitch(argv, io)
}

/** A zip holding one real UI, as `UiService` requires (an `index.html` at the root). */
async function uiZip(name = 'ui.zip', extra: Record<string, string> = {}): Promise<string> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add('index.html', new Uint8ArrayReader(Buffer.from('<!doctype html><title>mine</title>')))
  await writer.add('assets/app.js', new Uint8ArrayReader(Buffer.from('console.log(1)')))
  for (const [entry, content] of Object.entries(extra))
    await writer.add(entry, new Uint8ArrayReader(Buffer.from(content)))
  const file = path.join(tempDir('hh-uizip-'), name)
  fs.writeFileSync(file, await writer.close())
  return file
}

/** The recording replacement for `src/cli/io.ts`, and the answers its prompt gives. */
function fakeIo(answers: Array<string | Error | undefined> = []): {
  out: string
  prompts: string[]
  io: { write: (text: string) => void, prompt: (question: string) => Promise<string>, style: { bold: (text: string) => string, dim: (text: string) => string, green: (text: string) => string } }
} {
  const state = { out: '', prompts: [] as string[] }
  return {
    get out() {
      return state.out
    },
    get prompts() {
      return state.prompts
    },
    io: {
      write: (text: string) => { state.out += text },
      prompt: async (question: string) => {
        state.prompts.push(question)
        const answer = answers.shift()
        if (answer === undefined)
          throw new Error(`the prompt was asked again: ${question}`)
        if (answer instanceof Error)
          throw answer
        return answer
      },
      style: { bold: (text: string) => `<b>${text}</b>`, dim: (text: string) => `<d>${text}</d>`, green: (text: string) => `<g>${text}</g>` },
    },
  }
}

/** Answers a release lookup with one JSON release, and records what was asked for. */
function stubRelease(body: unknown, status = 200): Array<{ url: string, init: RequestInit | undefined }> {
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

/** Pretends the process has (or has no) terminal on stdin, the way `chooseAsset` reads it. */
function setTty(value: boolean | undefined): void {
  if (value === undefined)
    delete (process.stdin as { isTTY?: boolean }).isTTY
  else
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true })
}

beforeEach(() => {
  home = tempDir('hh-ui-home-')
  savedHome = process.env.HHOSTED_HOME
  process.env.HHOSTED_HOME = home
  // Installs land in `$HHOSTED_HOME`, resolved by the module under test when it is
  // imported; the wrapper only records what it was asked for.
  const recordingMkdtemp = async (prefix: string, options?: BufferEncoding): Promise<string> => {
    const dir = await realMkdtemp(prefix, options)
    dirs.push(dir)
    if (typeof prefix === 'string' && prefix.includes('hh-ui-') && !prefix.includes('hh-ui-home-'))
      downloadDirs.push(dir)
    return dir
  }
  fs.promises.mkdtemp = recordingMkdtemp as typeof fs.promises.mkdtemp
  setTty(undefined)
  // `src/helpers/paths.ts` resolves `dataRoot` once per module instance, so every test
  // needs its own instance: without this, test two installs into test one's temp home.
  vi.resetModules()
})

afterEach(async () => {
  fs.promises.mkdtemp = realMkdtemp
  setTty(undefined)
  vi.unstubAllGlobals()
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    if (savedTokens[key] === undefined)
      delete process.env[key]
    else process.env[key] = savedTokens[key]
  }
  if (savedHome === undefined)
    delete process.env.HHOSTED_HOME
  else process.env.HHOSTED_HOME = savedHome
  downloadDirs.length = 0
  for (const dir of dirs.splice(0))
    await fs.promises.rm(dir, { recursive: true, force: true })
})

describe('parseRepoSlug', () => {
  it('accepts an owner/name slug and rejects anything else', () => {
    expect(parseRepoSlug('NamesMT/home-hosted')).toEqual({ owner: 'NamesMT', name: 'home-hosted' })
    expect(parseRepoSlug('  a/b  ')).toEqual({ owner: 'a', name: 'b' })
    expect(parseRepoSlug('a.b/c_d-1')).toEqual({ owner: 'a.b', name: 'c_d-1' })

    for (const value of ['namesmt', 'a/b/c', 'a/', '/b', '', 'a b/c', 'a/b c'])
      expect(parseRepoSlug(value), value).toBeNull()
  })
})

describe('tag resolution', () => {
  it('uses this CLI version for our own repo and the latest release for another', () => {
    const own = parseRepoSlug('NamesMT/home-hosted')!
    const other = parseRepoSlug('someone/their-panel')!

    expect(defaultReleaseTag(own, '1.2.3')).toBe('v1.2.3')
    expect(defaultReleaseTag(other, '1.2.3')).toBeNull()
    expect(isOwnRepo(own)).toBe(true)
    expect(isOwnRepo(parseRepoSlug('NamesMT/other')!)).toBe(false)
  })
})

describe('releaseApiUrl', () => {
  const repo = { owner: 'a', name: 'b' }

  it('addresses latest by endpoint and a tag by name', () => {
    expect(releaseApiUrl(repo, null)).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, '')).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, 'latest')).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, 'v1.2.3')).toBe('https://api.github.com/repos/a/b/releases/tags/v1.2.3')
    expect(releaseApiUrl(repo, 'a/b c')).toBe('https://api.github.com/repos/a/b/releases/tags/a%2Fb%20c')
  })
})

describe('isUiAsset', () => {
  it('is a .zip, case-insensitively, and nothing else', () => {
    for (const name of ['home-hosted-ui-stock.zip', 'my-ui.ZIP', ' ui.zip '])
      expect(isUiAsset(name), name).toBe(true)

    for (const name of ['home-hosted-ui-stock.tar.gz', 'zip', 'ui.zip.sig', 'ui.txt', ''])
      expect(isUiAsset(name), name).toBe(false)
  })
})

describe('matchAsset', () => {
  const names = ['home-hosted-ui-noc-console.zip', 'home-hosted-ui-stock.zip']

  it('takes an exact name first', () => {
    expect(matchAsset(names, 'home-hosted-ui-stock.zip')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
  })

  it('falls back to case-insensitive and then to a single unambiguous substring', () => {
    expect(matchAsset(names, 'HOME-HOSTED-UI-STOCK.ZIP')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
    expect(matchAsset(names, 'stock')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
    expect(matchAsset(names, 'noc')).toEqual({ ok: true, name: 'home-hosted-ui-noc-console.zip' })
  })

  it('reports no match, and an ambiguous one, without guessing', () => {
    expect(matchAsset(names, 'ghost')).toMatchObject({ ok: false })
    expect(matchAsset(names, '')).toMatchObject({ ok: false })
    const ambiguous = matchAsset(names, 'home-hosted')
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ok === false && ambiguous.error).toContain('more than one')
  })
})

describe('parseFileSource', () => {
  it('treats http(s) as a URL and everything else as a path', () => {
    expect(parseFileSource('https://example.com/ui.zip')).toEqual({ kind: 'url', url: 'https://example.com/ui.zip' })
    expect(parseFileSource('HTTP://example.com/ui.zip')).toEqual({ kind: 'url', url: 'HTTP://example.com/ui.zip' })
    expect(parseFileSource('./uis/dist/my-ui.zip')).toEqual({ kind: 'path', path: './uis/dist/my-ui.zip' })
    expect(parseFileSource('C:\\builds\\ui.zip')).toEqual({ kind: 'path', path: 'C:\\builds\\ui.zip' })
  })

  it('expands a leading ~ against the home directory', () => {
    expect(parseFileSource('~')).toEqual({ kind: 'path', path: os.homedir() })
    expect(parseFileSource('~/ui.zip')).toEqual({ kind: 'path', path: path.join(os.homedir(), 'ui.zip') })
  })
})

describe('isGithubHost', () => {
  it('is true only for GitHub hosts, which is where a token may go', () => {
    for (const url of ['https://api.github.com/repos/a/b', 'https://github.com/a/b/releases/download/v1/x.zip', 'https://objects.githubusercontent.com/x'])
      expect(isGithubHost(url), url).toBe(true)

    for (const url of ['https://example.com/ui.zip', 'https://notgithub.com/x', 'https://github.com.evil.test/x', 'not a url'])
      expect(isGithubHost(url), url).toBe(false)
  })
})

describe('fallbackUiName', () => {
  it('names the install after the asset or file', () => {
    expect(fallbackUiName('home-hosted-ui-stock.zip')).toBe('stock')
    expect(fallbackUiName('/tmp/builds/my-panel.zip')).toBe('my-panel')
    expect(fallbackUiName('ui.ZIP')).toBe('ui')
    expect(fallbackUiName('')).toBe('custom-ui')
  })
})

function releaseUrl(tag: string | null = null): string {
  return `https://api.github.com/repos/${DEFAULT_REPO}/releases${tag === null ? '/latest' : `/tags/${tag}`}`
}

/** The tag `uiSwitch` asks for when it is not told: our own repo's tag for this version. */
async function ownTag(): Promise<string> {
  const { appVersion } = await import('#src/helpers/version')
  return `v${appVersion()}`
}

/** What a successful install leaves behind, under the temp `HHOSTED_HOME`. */
function installedHome(): { dir: string, meta: Record<string, unknown> } {
  const dir = path.join(home, '.ui')
  return { dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'ui.json'), 'utf8')) as Record<string, unknown> }
}

describe('uiSwitch --file', () => {
  it('installs a real zip into $HHOSTED_HOME and reports it', async () => {
    const io = fakeIo()
    const zip = await uiZip('home-hosted-ui-stock.zip')

    await runSwitch(['--file', zip], io.io)

    const { dir, meta } = installedHome()
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('mine')
    expect(meta.name).toBe('stock')
    expect(meta.files).toBe(2)

    expect(io.out).toContain('<g>UI installed</g> — stock')
    expect(io.out).toContain(`<d>state</d>  ${dir}`)
    expect(io.out).toContain('<d>files</d>  2')
    expect(io.out).toContain('refresh the browser to see it')
    expect(io.prompts).toEqual([])
  })

  it('reports the version the archive declared', async () => {
    const io = fakeIo()
    const zip = await uiZip('home-hosted-ui-noc.zip', {
      'ui.json': JSON.stringify({ name: 'noc-console', version: '2.1.0' }),
    })

    await runSwitch(['--file', zip], io.io)
    expect(io.out).toContain('UI installed</g> — noc-console 2.1.0')
  })

  it('refuses to mix a direct file with anything that picks a release', async () => {
    const io = fakeIo()
    const zip = await uiZip()

    for (const extra of [['--repo', 'a/b'], ['--tag', 'v1.0.0'], ['--asset', 'ui.zip'], ['--list']]) {
      const argv = ['--file', zip, ...extra]
      await expect(runSwitch(argv, io.io), argv.join(' '))
        .rejects
        .toThrow('--file installs a zip directly; it cannot be combined with --repo, --tag, --asset or --list')
    }

    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('fails clearly for a missing path and for a directory', async () => {
    const io = fakeIo()
    const missing = path.join(home, 'ghost.zip')

    await expect(runSwitch(['--file', missing], io.io)).rejects.toThrow(`no file at ${missing}`)
    await expect(runSwitch(['--file', home], io.io)).rejects.toThrow(`${home} is not a file`)
  })

  it('refuses an archive with no index.html through its own message', async () => {
    const io = fakeIo()
    const zip = await uiZip('ui.zip', { 'readme.txt': 'nothing to serve' })
    // Drop the index by building a zip with only the stray file.
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add('assets/only.js', new Uint8ArrayReader(Buffer.from('x')))
    const bare = path.join(tempDir('hh-uizip-'), 'bare.zip')
    fs.writeFileSync(bare, await writer.close())

    await expect(runSwitch(['--file', bare], io.io)).rejects.toThrow(/nothing was installed: the archive has no index\.html at its root/)
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
    expect(zip).toContain('ui.zip')
  })
})

describe('uiSwitch release listing', () => {
  const assets = [
    { name: 'home-hosted-ui-stock.zip', url: 'https://api.github.com/asset/1' },
    { name: 'notes.txt', url: 'https://api.github.com/asset/2' },
    { name: 'SHA256SUMS', url: 'https://api.github.com/asset/3' },
  ]

  it('lists the usable assets and the ones it skipped', async () => {
    const io = fakeIo()
    const calls = stubRelease({ tag_name: 'v1.2.3', assets })

    await runSwitch(['--tag', 'v1.2.3', '--list'], io.io)

    expect(calls[0]!.url).toBe(releaseUrl('v1.2.3'))
    expect(io.out).toContain(`<b>${DEFAULT_REPO}@v1.2.3</b> — 1 usable UI asset(s)`)
    expect(io.out).toContain('  home-hosted-ui-stock.zip')
    expect(io.out).toContain('<d>  skipped (not a .zip): notes.txt, SHA256SUMS</d>')
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
    expect(io.prompts).toEqual([])
  })

  it('fails with noAssetsMessage when nothing usable is attached', async () => {
    const io = fakeIo()
    stubRelease({ tag_name: 'v1.2.3', assets: [{ name: 'notes.txt' }] })

    await expect(runSwitch(['--tag', 'v1.2.3', '--list'], io.io))
      .rejects
      .toThrow(noAssetsMessage(`${DEFAULT_REPO}@v1.2.3`, ['notes.txt'], 'v1.2.3'))

    stubRelease({ tag_name: 'v1.2.3' })
    await expect(runSwitch(['--tag', 'v1.2.3', '--list'], io.io)).rejects.toThrow(/the release has no assets at all/)

    // Without --list the same release has nothing to install, and says so the same way.
    stubRelease({ tag_name: 'v1.2.3', assets: [{ name: 'notes.txt' }] })
    await expect(runSwitch(['--tag', 'v1.2.3'], io.io))
      .rejects
      .toThrow(noAssetsMessage(`${DEFAULT_REPO}@v1.2.3`, ['notes.txt'], 'v1.2.3'))
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('asks for this panel\'s own tag by default', async () => {
    const io = fakeIo()
    const calls = stubRelease({ tag_name: 'v9.9.9', assets: [{ name: 'ui.zip' }] })

    await runSwitch(['--list'], io.io)
    expect(calls[0]!.url).toBe(releaseUrl(await ownTag()))
  })

  it('skips an asset that never declared a name instead of tripping over it', async () => {
    const io = fakeIo()
    const calls = stubRelease({ tag_name: 'v1.2.3', assets: [{ url: 'https://api.github.com/asset/0' }, { name: 'home-hosted-ui-stock.zip', url: 'https://api.github.com/asset/1' }] })

    await runSwitch(['--tag', 'v1.2.3', '--list'], io.io)
    expect(io.out).toContain('<d>  skipped (not a .zip): ?</d>')

    // Installing a nameless asset is the same path: it is never a candidate.
    await expect(runSwitch(['--tag', 'v1.2.3', '--asset', 'stock'], io.io)).rejects.toThrow(/the upload is not a zip archive/)
    expect(calls.filter(call => call.url === 'https://api.github.com/asset/1')).toHaveLength(1)
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('runs through the citty entry the CLI dispatches to', async () => {
    const calls = stubRelease({ tag_name: 'v1.2.3', assets: [{ name: 'ui.zip' }] })
    const { uiSwitchCommand } = await import('#src/cli/ui-switch')
    const written: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      // `run` is what citty calls: it takes the raw flags and builds the real io seam.
      await uiSwitchCommand.run!({ rawArgs: ['--tag', 'v1.2.3', '--list'] } as never)
    }
    finally {
      process.stdout.write = original
    }

    expect(calls[0]!.url).toBe(releaseUrl('v1.2.3'))
    expect(written.join('')).toContain('ui.zip')
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('rejects an invalid --repo before any request', async () => {
    const io = fakeIo()
    const calls = stubRelease({ tag_name: 'v1.0.0' })

    await expect(runSwitch(['--repo', 'namesmt'], io.io))
      .rejects
      .toThrow(/invalid --repo "namesmt" — expected an "owner\/name" slug, e\.g\. NamesMT\/home-hosted/)
    expect(calls).toEqual([])
  })
})

const releaseAsset = (name: string, url: string): { name: string, url: string } => ({ name, url })
const twoAssets = [
  releaseAsset('home-hosted-ui-stock.zip', 'https://api.github.com/asset/1'),
  releaseAsset('home-hosted-ui-noc-console.zip', 'https://api.github.com/asset/2'),
]

/**
 * One stub for both halves of an install: the release lookup answers JSON, and every other
 * URL is the asset download, which serves a real zip so `UiService` runs for real.
 */
async function stubReleaseAndDownload(
  release: { tag_name?: string, assets?: unknown[] },
  options: { status?: number, zipName?: string, extra?: Record<string, string> } = {},
): Promise<Array<{ url: string, init: RequestInit | undefined }>> {
  const archive = fs.readFileSync(await uiZip(options.zipName ?? 'home-hosted-ui-stock.zip', options.extra))
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith('https://api.github.com/repos/'))
      return new Response(JSON.stringify(release), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } })
    return new Response(archive, { status: 200 })
  })
  return calls
}

/** The one non-release request the stub saw: the asset download. */
function downloadCall(calls: Array<{ url: string, init: RequestInit | undefined }>): { url: string, init: RequestInit | undefined } {
  const downloads = calls.filter(call => !call.url.startsWith('https://api.github.com/repos/'))
  expect(downloads).toHaveLength(1)
  return downloads[0]!
}

describe('uiSwitch asset selection', () => {
  it('installs the one asset a release carries without asking', async () => {
    const io = fakeIo()
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: [twoAssets[0]] })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(downloadCall(calls).url).toBe('https://api.github.com/asset/1')
    expect(io.prompts).toEqual([])
    expect(installedHome().meta.name).toBe('stock')
  })

  it('picks an asset by exact name, by case and by substring', async () => {
    for (const [query, expected, index] of [
      ['home-hosted-ui-stock.zip', 'home-hosted-ui-stock.zip', 1],
      ['HOME-HOSTED-UI-STOCK.ZIP', 'home-hosted-ui-stock.zip', 1],
      ['stock', 'home-hosted-ui-stock.zip', 1],
      ['noc-console', 'home-hosted-ui-noc-console.zip', 2],
    ] as const) {
      const io = fakeIo()
      const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

      await runSwitch(['--tag', 'v1.2.3', '--asset', query], io.io)

      expect(downloadCall(calls).url, query).toBe(`https://api.github.com/asset/${index}`)
      expect(io.prompts, query).toEqual([])
      // The install is named after the asset that was picked, never after the query.
      expect(installedHome().meta.name, query).toBe(fallbackUiName(expected))
      expect(io.out, query).toContain('UI installed')
    }
  })

  it('refuses an asset name nothing matches', async () => {
    const io = fakeIo()
    stubRelease({ tag_name: 'v1.2.3', assets: twoAssets })

    await expect(runSwitch(['--tag', 'v1.2.3', '--asset', 'ghost'], io.io))
      .rejects
      .toThrow(/no asset matches "ghost" \(available: home-hosted-ui-stock\.zip, home-hosted-ui-noc-console\.zip\)/)
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('will not guess between several assets when it cannot ask', async () => {
    const io = fakeIo()
    stubRelease({ tag_name: 'v1.2.3', assets: twoAssets })

    await expect(runSwitch(['--tag', 'v1.2.3'], io.io)).rejects.toThrow([
      '2 UI assets are available and this session cannot ask which one:',
      '  home-hosted-ui-stock.zip',
      '  home-hosted-ui-noc-console.zip',
      '  pick one with --asset <name>, or list them with --list',
    ].join('\n'))

    // `--yes` is not a "pick for me": it only means the question would be skipped.
    await expect(runSwitch(['--tag', 'v1.2.3', '--yes'], io.io)).rejects.toThrow(/cannot ask which one/)
    expect(io.prompts).toEqual([])
  })

  it('takes an in-range number at the prompt', async () => {
    const io = fakeIo(['1'])
    setTty(true)
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(io.prompts).toHaveLength(1)
    expect(io.prompts[0]).toContain('Select an asset [1-2] (empty to cancel)')
    expect(io.out).toContain('<b>Available UI assets</b>')
    expect(io.out).toContain('  1) home-hosted-ui-stock.zip')
    expect(io.out).toContain('  2) home-hosted-ui-noc-console.zip')
    expect(downloadCall(calls).url).toBe('https://api.github.com/asset/1')
    expect(installedHome().meta.name).toBe('stock')
  })

  it('retries an out-of-range number before taking a valid one', async () => {
    const io = fakeIo(['9', '2'])
    setTty(true)
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(io.prompts).toHaveLength(2)
    // `9` is not an index and matches no name either, so the loop says nothing was matched.
    expect(io.out).toContain('<d>no asset matches "9"')
    expect(downloadCall(calls).url).toBe('https://api.github.com/asset/2')
    expect(installedHome().meta.name).toBe('noc-console')
  })

  it('takes a substring name typed at the prompt', async () => {
    const io = fakeIo(['noc-console'])
    setTty(true)
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(io.prompts).toHaveLength(1)
    expect(downloadCall(calls).url).toBe('https://api.github.com/asset/2')
    expect(installedHome().meta.name).toBe('noc-console')
  })

  it('asks again when a typed name matches nothing', async () => {
    const io = fakeIo(['ghost', '1'])
    setTty(true)
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(io.prompts).toHaveLength(2)
    expect(io.out).toContain('<d>no asset matches "ghost"')
    expect(downloadCall(calls).url).toBe('https://api.github.com/asset/1')
  })

  it('cancels on an empty answer and installs nothing', async () => {
    const io = fakeIo([''])
    setTty(true)
    const calls = await stubReleaseAndDownload({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)

    expect(io.out).toContain('cancelled — nothing was installed\n')
    expect(io.prompts).toHaveLength(1)
    expect(calls.filter(call => !call.url.startsWith('https://api.github.com/repos/'))).toEqual([])
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })

  it('treats a whitespace-only answer as a cancel too', async () => {
    const io = fakeIo(['   '])
    setTty(true)
    stubRelease({ tag_name: 'v1.2.3', assets: twoAssets })

    await runSwitch(['--tag', 'v1.2.3'], io.io)
    expect(io.out).toContain('cancelled — nothing was installed')
  })
})

describe('uiSwitch installFromUrl', () => {
  /** Serves a real UI zip for any URL, recording what was asked for. */
  async function stubDownload(options: { status?: number, extra?: Record<string, string> } = {}): Promise<Array<{ url: string, init: RequestInit | undefined }>> {
    const archive = fs.readFileSync(await uiZip('ui.zip', options.extra ?? {}))
    const calls: Array<{ url: string, init: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(archive, { status: options.status ?? 200 })
    })
    return calls
  }

  it('sends the token to a GitHub host, and only the token', async () => {
    const io = fakeIo()
    const calls = await stubDownload()

    await runSwitch(['--file', 'https://github.com/a/b/releases/download/v1/ui.zip', '--token', 'gh-token'], io.io)

    const headers = requestHeaders(calls[0]!.init)
    expect(headers.accept).toBe('application/octet-stream')
    expect(headers['user-agent']).toMatch(/^home-hosted\//)
    expect(headers.authorization).toBe('Bearer gh-token')
    expect(io.out).toContain('UI installed')
    expect(installedHome().meta.name).toBe('ui')
    // The temp directory the download used is gone once the install is done.
    expect(downloadDirs.length).toBeGreaterThan(0)
    expect(downloadDirs.filter(dir => fs.existsSync(dir))).toEqual([])
  })

  it('never sends a token to a host the user did not vouch for', async () => {
    const io = fakeIo()
    const calls = await stubDownload()

    process.env.GITHUB_TOKEN = 'env-token'
    await runSwitch(['--file', 'https://example.com/ui.zip'], io.io)

    const headers = requestHeaders(calls[0]!.init)
    expect(headers).not.toHaveProperty('authorization')
    expect(JSON.stringify(headers)).not.toContain('env-token')
    expect(io.out).toContain('UI installed')
  })

  it('does not send even an explicit --token to a foreign host', async () => {
    const io = fakeIo()
    const calls = await stubDownload()

    await runSwitch(['--file', 'https://example.com/ui.zip', '--token', 'explicit-token'], io.io)
    expect(requestHeaders(calls[0]!.init)).not.toHaveProperty('authorization')
  })

  it('reads the token from GITHUB_TOKEN, and GH_TOKEN as the fallback', async () => {
    for (const [key, value] of [['GITHUB_TOKEN', 'from-github-token'], ['GH_TOKEN', 'from-gh-token']] as const) {
      delete process.env.GITHUB_TOKEN
      delete process.env.GH_TOKEN
      process.env[key] = value

      const io = fakeIo()
      const calls = await stubDownload()
      await runSwitch(['--file', 'https://api.github.com/repos/a/b/releases/assets/1'], io.io)
      expect(requestHeaders(calls[0]!.init).authorization, key).toBe(`Bearer ${value}`)
    }
  })

  it('falls back to the last path segment for the install name', async () => {
    const io = fakeIo()
    await stubDownload()

    await runSwitch(['--file', 'https://example.com/builds/my-panel.zip'], io.io)
    expect(installedHome().meta.name).toBe('my-panel')
    expect(io.out).toContain('UI installed</g> — my-panel')
  })

  it('reports a failed download and leaves the previous UI alone', async () => {
    const io = fakeIo()
    const calls = await stubDownload({ status: 404 })

    await expect(runSwitch(['--file', 'https://example.com/ui.zip'], io.io))
      .rejects
      .toThrow(/nothing is served at that URL \(HTTP 404\)/)
    expect(calls).toHaveLength(1)
    expect(fs.existsSync(path.join(home, '.ui'))).toBe(false)
  })
})
