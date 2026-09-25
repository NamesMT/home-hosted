import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
/**
 * The GitHub-release side of installing a UI: which repo, which tag, which asset, how
 * to read the release metadata and how to download one. `ui-switch` picks a release by
 * hand and `ui-update` follows what an installed UI declared, but both go through this
 * one implementation — the failure messages and the asset matching are the same problem.
 */

export const DEFAULT_REPO = 'NamesMT/home-hosted'
/** Mirrors the cap `UiService` enforces uncompressed — the same body, before it is parsed. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

export interface RepoSlug {
  owner: string
  name: string
}

export interface GithubAsset {
  name?: string
  url?: string
  browser_download_url?: string
}

export interface GithubRelease {
  tag_name?: string
  name?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: GithubAsset[]
}

/** What both commands need from the CLI that owns the readline prompts and the colours. */
export interface UiSourceIo {
  write: (text: string) => void
  prompt?: (question: string) => Promise<string>
  style: {
    bold: (text: string) => string
    dim: (text: string) => string
    green: (text: string) => string
  }
}

export interface UiSourceContext {
  io: UiSourceIo
  version: string
  token: string | null
  /** Suppress progress lines: the startup hook runs with nobody watching. */
  quiet?: boolean
}

/** `owner/name`, the only slug GitHub releases are addressed by. */
export function parseRepoSlug(value: string): RepoSlug | null {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(value.trim())
  if (match === null)
    return null
  return { owner: match[1]!, name: match[2]! }
}

export function repoSlug(repo: RepoSlug): string {
  return `${repo.owner}/${repo.name}`
}

/** The repo the default tag rule is about; `DEFAULT_REPO` is its only definition. */
export function isOwnRepo(repo: RepoSlug): boolean {
  return repoSlug(repo).toLowerCase() === DEFAULT_REPO.toLowerCase()
}

/**
 * Our own release tag matches this CLI's version, so a UI is paired with the panel
 * it was built for. Another repo has no such pairing, so its latest release is used.
 * `null` means "latest".
 */
export function defaultReleaseTag(repo: RepoSlug, version: string): string | null {
  return isOwnRepo(repo) ? `v${version}` : null
}

export function releaseApiUrl(repo: RepoSlug, tag: string | null): string {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases`
  if (tag === null || tag.length === 0 || tag === 'latest')
    return `${base}/latest`
  return `${base}/tags/${encodeURIComponent(tag)}`
}

/** Every published release, newest first, as GitHub orders them. */
export function releasesApiUrl(repo: RepoSlug, perPage = 30): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/releases?per_page=${perPage}`
}

/** Generous and predictable: a UI bundle is an asset whose name ends in `.zip`. */
export function isUiAsset(name: string): boolean {
  return /\.zip$/i.test(name.trim())
}

/**
 * Resolves a wanted asset: an exact name, a case-insensitive name, or a single
 * unambiguous substring (`--asset stock` for `home-hosted-ui-stock.zip`).
 */
export function matchAsset(names: readonly string[], query: string): { ok: true, name: string } | { ok: false, error: string } {
  const wanted = query.trim()
  if (wanted.length === 0)
    return { ok: false, error: 'no asset name was given' }

  const exact = names.find(name => name === wanted)
  if (exact !== undefined)
    return { ok: true, name: exact }

  const lower = wanted.toLowerCase()
  const insensitive = names.filter(name => name.toLowerCase() === lower)
  if (insensitive.length === 1)
    return { ok: true, name: insensitive[0]! }

  const partial = names.filter(name => name.toLowerCase().includes(lower))
  if (partial.length === 0)
    return { ok: false, error: `no asset matches "${wanted}" (available: ${names.join(', ') || 'none'})` }
  if (partial.length > 1)
    return { ok: false, error: `"${wanted}" matches more than one asset: ${partial.join(', ')} — use the full name` }
  return { ok: true, name: partial[0]! }
}

/** `^https?://` means a URL; anything else is a filesystem path with `~` expanded. */
export function parseFileSource(value: string): { kind: 'url', url: string } | { kind: 'path', path: string } {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed))
    return { kind: 'url', url: trimmed }
  return { kind: 'path', path: expandHome(trimmed) }
}

function expandHome(value: string): string {
  if (value === '~')
    return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * A token is only ever sent to GitHub: `--file <url>` may point anywhere, and a
 * credential must not leak to a host the user did not vouch for.
 */
export function isGithubHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'github.com' || host.endsWith('.github.com')
      || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
  }
  catch {
    return false
  }
}

/**
 * A hung connection must not become a hung command. `fetch` has no default timeout, and
 * the startup hook is fire-and-forget: without this a stalled request would keep that
 * promise (and its temp directory) pending for as long as the process lives.
 */
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 120_000

function timeoutSignal(ms: number): AbortSignal | undefined {
  // `AbortSignal.timeout` exists from Node 17.3; the engines field requires 24.
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** What `UiService` names the install when the archive carries no `ui.json`. */
export function fallbackUiName(source: string): string {
  const base = path.basename(source).replace(/\.zip$/i, '')
  const stripped = base.replace(/^home-hosted-ui-/i, '')
  return stripped.length > 0 ? stripped : 'custom-ui'
}

/** One release's assets, or a message that says what was wrong with the answer. */
export async function fetchRelease(repo: RepoSlug, tag: string | null, context: UiSourceContext): Promise<{ tag: string, assets: GithubAsset[] }> {
  const url = releaseApiUrl(repo, tag)
  let response: Response
  try {
    response = await fetch(url, { headers: apiHeaders(context), signal: timeoutSignal(REQUEST_TIMEOUT_MS) })
  }
  catch (error) {
    throw new Error(isTimeout(error) ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000}s` : `could not reach GitHub: ${describeError(error)}`)
  }

  if (!response.ok)
    throw new Error(describeReleaseFailure(response.status, repo, tag))

  const body = await response.json() as GithubRelease
  return { tag: body.tag_name ?? tag ?? 'latest', assets: Array.isArray(body.assets) ? body.assets : [] }
}

/** Every published release, newest first. Drafts and unusable entries are dropped. */
export async function fetchReleases(repo: RepoSlug, context: UiSourceContext, perPage = 30): Promise<Array<{ tag: string, assets: GithubAsset[], publishedAt: string | null }>> {
  let response: Response
  try {
    response = await fetch(releasesApiUrl(repo, perPage), { headers: apiHeaders(context), signal: timeoutSignal(REQUEST_TIMEOUT_MS) })
  }
  catch (error) {
    throw new Error(isTimeout(error) ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000}s` : `could not reach GitHub: ${describeError(error)}`)
  }

  if (!response.ok)
    throw new Error(describeReleaseFailure(response.status, repo, null))

  const body = await response.json()
  if (!Array.isArray(body))
    return []

  return (body as GithubRelease[])
    .filter(release => release.draft !== true && typeof release.tag_name === 'string')
    .map(release => ({
      tag: release.tag_name!,
      assets: Array.isArray(release.assets) ? release.assets : [],
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    }))
}

export function assetDownloadUrl(asset: GithubAsset): string {
  const url = asset.url ?? asset.browser_download_url
  if (url === undefined || url.length === 0)
    throw new Error(`the release metadata for "${asset.name ?? 'an asset'}" carries no download URL`)
  return url
}

/** Streams to `os.tmpdir()` so a large body is never buffered in memory. */
export async function downloadToTemp(url: string, headers: Record<string, string>, context: UiSourceContext): Promise<{ dir: string, file: string }> {
  let response: Response
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal: timeoutSignal(DOWNLOAD_TIMEOUT_MS) })
  }
  catch (error) {
    throw new Error(isTimeout(error) ? `the download stalled for ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}` : `could not reach ${url}: ${describeError(error)}`)
  }

  if (!response.ok)
    throw new Error(describeDownloadFailure(response.status, url))

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared < 0)
    throw new Error(`the download from ${url} reported an unusable size`)
  if (declared > MAX_DOWNLOAD_BYTES)
    throw new Error(tooLargeMessage(declared))
  if (response.body === null)
    throw new Error(`the download from ${url} had no body`)

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-ui-'))
  const file = path.join(dir, 'ui.zip')
  const handle = await fs.promises.open(file, 'w')
  let received = 0

  try {
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > MAX_DOWNLOAD_BYTES)
        throw new Error(tooLargeMessage(received))
      await handle.write(chunk)
    }
  }
  catch (error) {
    await handle.close()
    fs.rmSync(dir, { recursive: true, force: true })
    throw error instanceof Error ? error : new Error(String(error))
  }
  await handle.close()

  if (context.quiet !== true)
    context.io.write(`${context.io.style.dim(`downloaded ${formatBytes(received)}`)}\n`)
  return { dir, file }
}

export function apiHeaders(context: UiSourceContext): Record<string, string> {
  const headers: Record<string, string> = {
    'accept': 'application/vnd.github+json',
    'user-agent': `home-hosted/${context.version}`,
    'x-github-api-version': '2022-11-28',
  }
  if (context.token !== null && context.token.length > 0)
    headers.authorization = `Bearer ${context.token}`
  return headers
}

export function noAssetsMessage(where: string, skipped: string[], tag: string | null): string {
  const lines = [`no usable UI assets in ${where} (expected a .zip)`]
  lines.push(skipped.length > 0 ? `  skipped: ${skipped.join(', ')}` : '  the release has no assets at all')
  if (tag !== null && tag !== 'latest')
    lines.push('  installing a different version silently is worse than failing: try the newest release with --tag latest')
  return lines.join('\n')
}

export function describeReleaseFailure(status: number, repo: RepoSlug, tag: string | null): string {
  const slug = repoSlug(repo)
  if (status === 404) {
    if (tag !== null && tag !== 'latest')
      return `no release tagged "${tag}" in ${slug}\n  list what exists with: home-hosted ui-switch --repo ${slug} --tag latest --list`
    return `no repository or published release at ${slug}\n  check the --repo slug (owner/name), and that the repository is public`
  }
  if (status === 403 || status === 429)
    return `GitHub refused the request (HTTP ${status}) — the unauthenticated API rate limit is per address.\n  set a token to raise it: --token <token>, or GITHUB_TOKEN / GH_TOKEN`
  if (status === 401)
    return 'GitHub rejected the token (HTTP 401) — check --token, GITHUB_TOKEN or GH_TOKEN'
  return `GitHub answered HTTP ${status} while reading the release of ${slug}`
}

function describeDownloadFailure(status: number, url: string): string {
  const github = isGithubHost(url)
  if (status === 404) {
    return github
      ? `the asset is gone (HTTP 404) — ${url}\n  the release may have been rebuilt since it was listed; run the command again`
      : `nothing is served at that URL (HTTP 404) — ${url}`
  }
  if (status === 403 || status === 429) {
    return github
      ? `GitHub refused the download (HTTP ${status}) — a token raises the rate limit: --token <token>, or GITHUB_TOKEN / GH_TOKEN`
      : `the host refused the download (HTTP ${status}) — ${url}`
  }
  if (status === 401 && github)
    return 'GitHub rejected the token on the download (HTTP 401) — check --token, GITHUB_TOKEN or GH_TOKEN'
  return `the download failed (HTTP ${status}) — ${url}`
}

function tooLargeMessage(bytes: number): string {
  return `the download is ${formatBytes(bytes)}, larger than the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB a UI may be`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tag ordering: `v1.2.3` beats `v1.2.2`, a prerelease loses to its release, and anything
 * that is not a version sorts below every version that is. Enough to answer "is this
 * release newer than the one the UI came from" without a semver dependency.
 */
export function compareTags(a: string, b: string): number {
  const left = parseTag(a)
  const right = parseTag(b)
  if (left === null && right === null)
    return a.localeCompare(b)
  if (left === null)
    return -1
  if (right === null)
    return 1

  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference !== 0)
      return difference
  }

  // A release outranks its own prereleases, and two prereleases are ordered by their
  // identifiers — `rc.2` after `rc.1`. Comparing only "is it a prerelease" made every
  // pair of them equal, so `ui-update` hid each one from the other.
  if (left.prerelease.length === 0 && right.prerelease.length === 0)
    return 0
  if (left.prerelease.length === 0)
    return 1
  if (right.prerelease.length === 0)
    return -1

  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const one = left.prerelease[index]
    const two = right.prerelease[index]
    if (one === undefined)
      return -1
    if (two === undefined)
      return 1
    if (one === two)
      continue
    const numeric = /^\d+$/
    if (numeric.test(one) && numeric.test(two))
      return Number(one) - Number(two)
    // Numeric identifiers rank below alphanumeric ones, per semver.
    if (numeric.test(one))
      return -1
    if (numeric.test(two))
      return 1
    return one.localeCompare(two)
  }
  return 0
}

function parseTag(tag: string): { parts: number[], prerelease: string[] } | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(tag.trim())
  if (match === null)
    return null
  return {
    parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}
