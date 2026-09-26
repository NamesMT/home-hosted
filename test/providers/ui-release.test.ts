import type { UiSourceContext } from '#src/providers/ui-release'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiHeaders,
  assetDownloadUrl,
  compareTags,
  describeReleaseFailure,
  downloadToTemp,
  fetchRelease,
  fetchReleases,
  formatBytes,
  matchAsset,
  MAX_DOWNLOAD_BYTES,
  noAssetsMessage,
  releaseApiUrl,
  releasesApiUrl,
} from '#src/providers/ui-release'

/**
 * The release side of installing a UI, off the network: `fetch` is the only thing
 * stubbed, with a real `Response` so the status, header and stream behaviour under
 * test is the platform's rather than a mock's.
 */

const repo = { owner: 'a', name: 'b' }

/** Where `downloadToTemp` actually put its temp directory, so cleanup is observable. */
const tempDirs: Array<{ prefix: string, dir: string }> = []
const realMkdtemp = fs.promises.mkdtemp

interface FetchCall { url: string, init: RequestInit | undefined }

/** A `fetch` stub that records the URL and the init it was handed. */
function stubFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    calls.push({ url, init })
    return respond(url, init)
  })
  return calls
}

function recordingIo(): { lines: string[], io: UiSourceContext['io'] } {
  const lines: string[] = []
  return {
    lines,
    io: {
      write: (text: string) => { lines.push(text) },
      style: { bold: text => `<b>${text}</b>`, dim: text => `<d>${text}</d>`, green: text => `<g>${text}</g>` },
    },
  }
}

function makeContext(options: { token?: string | null, version?: string, quiet?: boolean } = {}): { context: UiSourceContext, lines: string[] } {
  const { lines, io } = recordingIo()
  return {
    lines,
    context: {
      io,
      version: options.version ?? '9.9.9',
      token: options.token === undefined ? null : options.token,
      ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    },
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  // Wrapped, not stubbed: the real mkdtemp still runs, and every directory it makes is
  // recorded here so a test can prove what `downloadToTemp` did (and did not) clean up.
  const recordingMkdtemp = async (prefix: string, options?: BufferEncoding): Promise<string> => {
    const dir = await realMkdtemp(prefix, options)
    tempDirs.push({ prefix: String(prefix), dir })
    return dir
  }
  fs.promises.mkdtemp = recordingMkdtemp as typeof fs.promises.mkdtemp
})

afterEach(async () => {
  fs.promises.mkdtemp = realMkdtemp
  vi.unstubAllGlobals()
  for (const entry of tempDirs.splice(0))
    await fs.promises.rm(entry.dir, { recursive: true, force: true })
})

describe('apiHeaders', () => {
  it('always names this client, the accepted media type and the API version', () => {
    const { context } = makeContext()
    expect(apiHeaders(context)).toEqual({
      'accept': 'application/vnd.github+json',
      'user-agent': 'home-hosted/9.9.9',
      'x-github-api-version': '2022-11-28',
    })
  })

  it('adds the bearer token only when there is a non-empty one', () => {
    expect(apiHeaders(makeContext({ token: 's3cret' }).context))
      .toMatchObject({ authorization: 'Bearer s3cret' })
    expect(apiHeaders(makeContext({ token: 's3cret' }).context)['x-github-api-version']).toBe('2022-11-28')

    for (const token of [null, ''])
      expect(apiHeaders(makeContext({ token }).context), String(token)).not.toHaveProperty('authorization')
  })
})

describe('fetchRelease', () => {
  it('reads the tag and the assets from the release body', async () => {
    const { context } = makeContext({ token: 'tok' })
    const calls = stubFetch(() => json({ tag_name: 'v1.2.3', assets: [{ name: 'ui.zip', url: 'https://x/1' }] }))

    const release = await fetchRelease(repo, 'v1.2.3', context)
    expect(release).toEqual({ tag: 'v1.2.3', assets: [{ name: 'ui.zip', url: 'https://x/1' }] })

    // The request went to the tag endpoint with our headers, and a token.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(releaseApiUrl(repo, 'v1.2.3'))
    expect(calls[0]!.init?.headers).toEqual(apiHeaders(context))
    expect((calls[0]!.init?.headers as Record<string, string>)['x-github-api-version']).toBe('2022-11-28')
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('addresses `latest` through the same helper the caller would', async () => {
    const { context } = makeContext()
    const calls = stubFetch(() => json({ tag_name: 'v2.0.0' }))

    await fetchRelease(repo, null, context)
    expect(calls[0]!.url).toBe('https://api.github.com/repos/a/b/releases/latest')
  })

  it('reports no assets rather than a missing key', async () => {
    const { context } = makeContext()
    stubFetch(() => json({ tag_name: 'v1.0.0' }))
    expect(await fetchRelease(repo, null, context)).toEqual({ tag: 'v1.0.0', assets: [] })

    stubFetch(() => json({ tag_name: 'v1.0.0', assets: 'not-an-array' }))
    expect(await fetchRelease(repo, null, context)).toEqual({ tag: 'v1.0.0', assets: [] })
  })

  it('falls back to the requested tag when the body does not name one', async () => {
    const { context } = makeContext()
    stubFetch(() => json({}))
    expect((await fetchRelease(repo, 'v9.0.0', context)).tag).toBe('v9.0.0')

    stubFetch(() => json({}))
    expect((await fetchRelease(repo, null, context)).tag).toBe('latest')
  })

  it('explains a 404 differently for a named tag and for `latest`', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response('{"message":"Not Found"}', { status: 404 }))

    await expect(fetchRelease(repo, 'v1.2.3', context)).rejects.toThrow(describeReleaseFailure(404, repo, 'v1.2.3'))
    await expect(fetchRelease(repo, 'v1.2.3', context)).rejects.toThrow(/no release tagged "v1\.2\.3" in a\/b/)
    await expect(fetchRelease(repo, 'v1.2.3', context)).rejects.toThrow(/ui-switch --repo a\/b --tag latest --list/)

    await expect(fetchRelease(repo, null, context)).rejects.toThrow(describeReleaseFailure(404, repo, null))
    await expect(fetchRelease(repo, 'latest', context)).rejects.toThrow(/no repository or published release at a\/b/)
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/check the --repo slug/)
  })

  it('explains a rate limit, a rejected token and anything else', async () => {
    const { context } = makeContext()

    for (const status of [403, 429]) {
      stubFetch(() => new Response('', { status }))
      await expect(fetchRelease(repo, null, context), String(status))
        .rejects
        .toThrow(describeReleaseFailure(status, repo, null))
      await expect(fetchRelease(repo, null, context), String(status))
        .rejects
        .toThrow(new RegExp(`GitHub refused the request \\(HTTP ${status}\\)`))
    }

    stubFetch(() => new Response('', { status: 403 }))
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/unauthenticated API rate limit is per address/)
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/--token <token>, or GITHUB_TOKEN \/ GH_TOKEN/)

    stubFetch(() => new Response('', { status: 401 }))
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/GitHub rejected the token \(HTTP 401\)/)

    stubFetch(() => new Response('', { status: 500 }))
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(describeReleaseFailure(500, repo, null))
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/GitHub answered HTTP 500 while reading the release of a\/b/)
  })

  it('says GitHub was unreachable when fetch itself fails', async () => {
    const { context } = makeContext()
    vi.stubGlobal('fetch', async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') })
    await expect(fetchRelease(repo, null, context)).rejects.toThrow(/^could not reach GitHub: getaddrinfo ENOTFOUND/)

    // A non-Error throw, to pin the `String(error)` branch of the message.
    // eslint-disable-next-line no-throw-literal
    vi.stubGlobal('fetch', async () => { throw 'not an error object' })
    await expect(fetchRelease(repo, null, context)).rejects.toThrow('could not reach GitHub: not an error object')
  })

  it('names the 30s request timeout instead of reporting it as unreachable', async () => {
    const { context } = makeContext()

    for (const name of ['TimeoutError', 'AbortError']) {
      vi.stubGlobal('fetch', async () => {
        const error = new Error('the operation was aborted')
        error.name = name
        throw error
      })
      await expect(fetchRelease(repo, null, context), name).rejects.toThrow('GitHub did not answer within 30s')
    }
  })
})

describe('fetchReleases', () => {
  it('keeps published, named releases and normalises what each one carries', async () => {
    const { context } = makeContext()
    const calls = stubFetch(() => json([
      { tag_name: 'v3.0.0', published_at: '2025-01-01T00:00:00Z', assets: [{ name: 'ui.zip' }] },
      { tag_name: 'v2.0.0', draft: true, published_at: '2024-01-01T00:00:00Z' },
      { tag_name: 'v1.9.0', published_at: 1700000000 },
      { tag_name: 42, published_at: '2024-01-01T00:00:00Z' },
      { draft: false, published_at: '2024-01-01T00:00:00Z' },
      { tag_name: 'v1.0.0', published_at: null, assets: 'nope' },
    ]))

    expect(await fetchReleases(repo, context, 5)).toEqual([
      { tag: 'v3.0.0', assets: [{ name: 'ui.zip' }], publishedAt: '2025-01-01T00:00:00Z' },
      { tag: 'v1.9.0', assets: [], publishedAt: null },
      { tag: 'v1.0.0', assets: [], publishedAt: null },
    ])

    expect(calls[0]!.url).toBe(releasesApiUrl(repo, 5))
    expect(calls[0]!.init?.headers).toEqual(apiHeaders(context))
  })

  it('returns nothing for a body that is not a list', async () => {
    const { context } = makeContext()
    stubFetch(() => json({ message: 'Bad credentials' }))
    expect(await fetchReleases(repo, context)).toEqual([])
  })

  it('throws on a failed request instead of returning an empty list', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response('', { status: 500 }))
    await expect(fetchReleases(repo, context)).rejects.toThrow(describeReleaseFailure(500, repo, null))

    vi.stubGlobal('fetch', async () => {
      const error = new Error('aborted')
      error.name = 'TimeoutError'
      throw error
    })
    await expect(fetchReleases(repo, context)).rejects.toThrow('GitHub did not answer within 30s')
  })
})

describe('downloadToTemp', () => {
  it('writes the body into a fresh temp directory and reports one dimmed line', async () => {
    const { context, lines } = makeContext()
    const calls = stubFetch(() => new Response('zip-bytes'))

    const downloaded = await downloadToTemp('https://example.com/ui.zip', { accept: 'application/octet-stream' }, context)

    expect(fs.readFileSync(downloaded.file, 'utf8')).toBe('zip-bytes')
    expect(downloaded.file).toBe(path.join(downloaded.dir, 'ui.zip'))
    expect(path.basename(downloaded.dir)).toMatch(/^hh-ui-/)
    expect(tempDirs.map(entry => entry.dir)).toContain(downloaded.dir)
    expect(tempDirs[0]!.prefix).toBe(path.join(os.tmpdir(), 'hh-ui-'))
    expect(fs.statSync(downloaded.file).size).toBe(9)

    expect(calls[0]!.url).toBe('https://example.com/ui.zip')
    expect(calls[0]!.init?.redirect).toBe('follow')
    expect(calls[0]!.init?.headers).toEqual({ accept: 'application/octet-stream' })
    expect(lines).toEqual(['<d>downloaded 9 B</d>\n'])
  })

  it('writes nothing at all when the caller asked for quiet', async () => {
    const { context, lines } = makeContext({ quiet: true })
    stubFetch(() => new Response('zip-bytes'))

    await downloadToTemp('https://example.com/ui.zip', {}, context)
    expect(lines).toEqual([])
  })

  it('reports a stalled download by its own timeout', async () => {
    const { context } = makeContext()

    vi.stubGlobal('fetch', async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context))
      .rejects
      .toThrow('the download stalled for 120s: https://example.com/ui.zip')

    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context))
      .rejects
      .toThrow('could not reach https://example.com/ui.zip: ECONNREFUSED')
  })

  it('reads a 404 as a missing release asset on GitHub and a missing page elsewhere', async () => {
    const { context } = makeContext()
    const github = 'https://github.com/a/b/releases/download/v1/ui.zip'

    stubFetch(() => new Response('', { status: 404 }))
    await expect(downloadToTemp(github, {}, context)).rejects.toThrow(/the asset is gone \(HTTP 404\)/)
    await expect(downloadToTemp(github, {}, context)).rejects.toThrow(/run the command again/)
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow(/nothing is served at that URL \(HTTP 404\)/)
  })

  it('blames GitHub for a rate limit on its hosts and the host itself otherwise', async () => {
    const { context } = makeContext()
    const github = 'https://objects.githubusercontent.com/x/ui.zip'

    for (const status of [403, 429]) {
      stubFetch(() => new Response('', { status }))
      await expect(downloadToTemp(github, {}, context), `github ${status}`)
        .rejects
        .toThrow(`GitHub refused the download (HTTP ${status})`)
      await expect(downloadToTemp('https://example.com/ui.zip', {}, context), `other ${status}`)
        .rejects
        .toThrow(`the host refused the download (HTTP ${status})`)
    }

    stubFetch(() => new Response('', { status: 401 }))
    await expect(downloadToTemp(github, {}, context)).rejects.toThrow('GitHub rejected the token on the download (HTTP 401)')
    // A 401 from anywhere else is just another failed download.
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow('the download failed (HTTP 401)')

    stubFetch(() => new Response('', { status: 500 }))
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow('the download failed (HTTP 500)')
  })

  it('refuses a declared size above the cap before reading a byte', async () => {
    const { context } = makeContext()
    const calls = stubFetch(() => new Response('x', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } }))

    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow(/larger than the 512MB a UI may be/)
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow(/is 512\.0 MB/)
    expect(calls[0]).toBeDefined()
    // Nothing was created and nothing was streamed: the declared size was enough.
    expect(tempDirs).toEqual([])
  })

  it('refuses an unusable declared size', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response('x', { headers: { 'content-length': 'not-a-number' } }))
    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow(/reported an unusable size/)
  })

  it('stops a body that streams past the cap and removes the temp directory', async () => {
    const { context } = makeContext()
    // Lazily zero-filled: the page is only written to if something reads it, which the cap
    // check prevents before the first `handle.write`.
    const oversized = new Uint8Array(MAX_DOWNLOAD_BYTES + 1)
    stubFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversized)
        controller.close()
      },
    })))

    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow(/larger than the 512MB a UI may be/)
    expect(tempDirs).toHaveLength(1)
    expect(fs.existsSync(tempDirs[0]!.dir)).toBe(false)
  })

  it('refuses a response with no body', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response(null, { status: 200 }))
    await expect(downloadToTemp('http://example.com/ui.zip', {}, context)).rejects.toThrow('the download from http://example.com/ui.zip had no body')
    expect(tempDirs).toEqual([])
  })

  it('removes the half-written temp directory when the body errors mid-stream', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
      },
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })))

    await expect(downloadToTemp('https://example.com/ui.zip', {}, context)).rejects.toThrow('connection reset')
    expect(tempDirs).toHaveLength(1)
    expect(fs.existsSync(tempDirs[0]!.dir)).toBe(false)
  })
})

describe('assetDownloadUrl', () => {
  it('prefers the API url and falls back to the browser one', () => {
    expect(assetDownloadUrl({ name: 'ui.zip', url: 'https://api/asset/1' })).toBe('https://api/asset/1')
    expect(assetDownloadUrl({ name: 'ui.zip', browser_download_url: 'https://github/releases/ui.zip' }))
      .toBe('https://github/releases/ui.zip')
  })

  it('throws when neither field carries a URL', () => {
    for (const asset of [{ name: 'ui.zip' }, {}, { name: 'ui.zip', url: '', browser_download_url: '' }])
      expect(() => assetDownloadUrl(asset), JSON.stringify(asset)).toThrow(/carries no download URL/)

    expect(() => assetDownloadUrl({ name: 'ui.zip' })).toThrow(/the release metadata for "ui.zip"/)
    expect(() => assetDownloadUrl({})).toThrow(/the release metadata for "an asset"/)
  })
})

describe('noAssetsMessage', () => {
  it('lists what was skipped', () => {
    const message = noAssetsMessage('a/b@v1.2.3', ['notes.txt', 'checksums.sig'], 'v1.2.3')
    expect(message).toContain('no usable UI assets in a/b@v1.2.3 (expected a .zip)')
    expect(message).toContain('  skipped: notes.txt, checksums.sig')
  })

  it('says a release with nothing in it is empty', () => {
    expect(noAssetsMessage('a/b@v1.2.3', [], null)).toContain('  the release has no assets at all')
  })

  it('only suggests --tag latest when a tag was pinned', () => {
    for (const tag of ['v1.2.3', 'v0.1.0'])
      expect(noAssetsMessage('a/b', [], tag), tag).toContain('try the newest release with --tag latest')

    for (const tag of [null, 'latest'])
      expect(noAssetsMessage('a/b', [], tag), String(tag)).not.toContain('--tag latest')
  })
})

describe('formatBytes', () => {
  it('switches from bytes to KB to MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(MAX_DOWNLOAD_BYTES)).toBe('512.0 MB')
  })
})

describe('compareTags', () => {
  it('reads a tag with no numbers at all as "not a version", and orders it below one', () => {
    // Both sides unparseable: the only remaining order is the string's own.
    expect(compareTags('nightly', 'alpha')).toBe('nightly'.localeCompare('alpha'))
    expect(compareTags('nightly', 'v1.0.0')).toBeLessThan(0)
    expect(compareTags('v1.0.0', 'nightly')).toBeGreaterThan(0)
    expect(compareTags('', 'v1.0.0')).toBeLessThan(0)
  })

  it('orders releases by their numbers', () => {
    expect(compareTags('v1.2.3', 'v1.2.2')).toBeGreaterThan(0)
    expect(compareTags('v1.2.2', 'v1.2.3')).toBeLessThan(0)
    expect(compareTags('v1.2.3', 'v1.2.3')).toBe(0)
    expect(compareTags('v2.0.0', 'v1.99.99')).toBeGreaterThan(0)
    expect(compareTags('v1.3.0', 'v1.2.9')).toBeGreaterThan(0)
  })

  it('reads a missing minor or patch as zero, and a leading v as optional', () => {
    expect(compareTags('v1', '1.0.0')).toBe(0)
    expect(compareTags('v1.2', 'v1.2.0')).toBe(0)
    expect(compareTags('1.2.3', 'v1.2.3')).toBe(0)
    expect(compareTags('v1.2', 'v1.2.1')).toBeLessThan(0)
  })

  it('ignores a build suffix', () => {
    expect(compareTags('v1.2.3+build.7', 'v1.2.3')).toBe(0)
    expect(compareTags('v1.2.3-rc.1+sha.abc', 'v1.2.3-rc.1')).toBe(0)
  })

  it('puts a prerelease below its own release', () => {
    expect(compareTags('v1.2.3-rc.1', 'v1.2.3')).toBeLessThan(0)
    expect(compareTags('v1.2.3', 'v1.2.3-rc.1')).toBeGreaterThan(0)
    expect(compareTags('v1.2.3-rc.1', 'v1.2.4')).toBeLessThan(0)
  })

  it('orders two prereleases by their identifiers, numbers before words', () => {
    expect(compareTags('v1.2.3-rc.1', 'v1.2.3-rc.2')).toBeLessThan(0)
    expect(compareTags('v1.2.3-rc.2', 'v1.2.3-rc.1')).toBeGreaterThan(0)
    expect(compareTags('v1.2.3-rc.10', 'v1.2.3-rc.9')).toBeGreaterThan(0)
    // Numeric identifiers rank below alphanumeric ones, per semver.
    expect(compareTags('v1.2.3-1', 'v1.2.3-alpha')).toBeLessThan(0)
    expect(compareTags('v1.2.3-alpha', 'v1.2.3-1')).toBeGreaterThan(0)
    expect(compareTags('v1.2.3-alpha', 'v1.2.3-beta')).toBeLessThan(0)
    // Fewer identifiers first: `rc` precedes `rc.1`.
    expect(compareTags('v1.2.3-rc', 'v1.2.3-rc.1')).toBeLessThan(0)
    expect(compareTags('v1.2.3-rc.1', 'v1.2.3-rc')).toBeGreaterThan(0)
  })

  it('sorts anything that is not a version below every version', () => {
    for (const tag of ['nightly', 'latest', 'vNext', '', 'release-1.2.3'])
      expect(compareTags(tag, 'v0.0.1'), tag).toBeLessThan(0)

    for (const tag of ['nightly', 'latest', 'vNext', ''])
      expect(compareTags('v0.0.1', tag), tag).toBeGreaterThan(0)

    expect(compareTags('v1.2.3', 'nightly')).toBeGreaterThan(0)
  })

  it('falls back to localeCompare when neither is a version', () => {
    expect(compareTags('alpha', 'beta')).toBe('alpha'.localeCompare('beta'))
    expect(compareTags('beta', 'alpha')).toBe('beta'.localeCompare('alpha'))
    expect(compareTags('nightly', 'nightly')).toBe(0)
  })
})

describe('coverage of the defensive branches', () => {
  it('has an empty asset list when a release is missing its own tag and name', async () => {
    const { context } = makeContext()
    stubFetch(() => new Response(JSON.stringify({ assets: [{ url: 'https://api.github.com/asset/1' }] }), { status: 200 }))

    await expect(fetchRelease(repo, null, context)).resolves.toEqual({ tag: 'latest', assets: [{ url: 'https://api.github.com/asset/1' }] })
  })

  it('names the available assets as "none" when nothing is on offer', async () => {
    // `matchAsset` builds that message itself; an empty roster is its own edge.
    expect(matchAsset([], 'ghost')).toEqual({ ok: false, error: 'no asset matches "ghost" (available: none)' })
  })

  it('wraps a non-Error a download body threw, and still cleans up', async () => {
    const { context } = makeContext()
    const dirs: string[] = []
    const realMkdtemp = fs.promises.mkdtemp
    const recordingMkdtemp = async (prefix: string, options?: BufferEncoding): Promise<string> => {
      const dir = await realMkdtemp(prefix, options)
      dirs.push(dir)
      return dir
    }
    fs.promises.mkdtemp = recordingMkdtemp as typeof fs.promises.mkdtemp

    try {
      // A stream that fails with a bare string, not an Error.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
          controller.error('the connection died')
        },
      })
      stubFetch(() => new Response(body, { status: 200 }))

      await expect(downloadToTemp('https://example.com/ui.zip', {}, context))
        .rejects
        .toThrow('the connection died')
      expect(dirs.filter(dir => fs.existsSync(dir))).toEqual([])
    }
    finally {
      fs.promises.mkdtemp = realMkdtemp
    }
  })
})
