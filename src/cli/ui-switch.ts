import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { defineCommand } from 'citty'
import { prompt, style } from '#src/cli/io'

/**
 * `home-hosted ui-switch` installs the panel's frontend UI without the settings
 * page: a GitHub release asset (the default), a local zip, or an http(s) URL.
 *
 * This module is only ever imported dynamically, after `--home` has been applied,
 * so the modules that read the state directories are imported inside the command
 * rather than at the top. The helpers it exports are pure and testable on their own.
 */

export const DEFAULT_REPO = 'NamesMT/home-hosted'
/** Mirrors the cap `UiService` enforces uncompressed — the same body, before it is parsed. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** What the command needs from the CLI that owns the readline prompts and the colours. */
export interface UiSwitchIo {
  write: (text: string) => void
  prompt: (question: string) => Promise<string>
  style: {
    bold: (text: string) => string
    dim: (text: string) => string
    green: (text: string) => string
  }
}

export interface RepoSlug {
  owner: string
  name: string
}

interface GithubAsset {
  name?: string
  url?: string
  browser_download_url?: string
}

interface GithubRelease {
  tag_name?: string
  assets?: GithubAsset[]
}

interface SwitchContext {
  io: UiSwitchIo
  version: string
  token: string | null
}

/** `owner/name`, the only slug GitHub releases are addressed by. */
export function parseRepoSlug(value: string): RepoSlug | null {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(value.trim())
  if (match === null)
    return null
  return { owner: match[1]!, name: match[2]! }
}

/** The repo the default tag rule is about; `DEFAULT_REPO` is its only definition. */
export function isOwnRepo(repo: RepoSlug): boolean {
  return `${repo.owner}/${repo.name}`.toLowerCase() === DEFAULT_REPO.toLowerCase()
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

/** Generous and predictable: a UI bundle is an asset whose name ends in `.zip`. */
export function isUiAsset(name: string): boolean {
  return /\.zip$/i.test(name.trim())
}

/**
 * Resolves `--asset`: an exact name, a case-insensitive name, or a single
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

/** What `UiService` names the install when the archive carries no `ui.json`. */
export function fallbackUiName(source: string): string {
  const base = path.basename(source).replace(/\.zip$/i, '')
  const stripped = base.replace(/^home-hosted-ui-/i, '')
  return stripped.length > 0 ? stripped : 'custom-ui'
}

export async function uiSwitch(argv: string[], io: UiSwitchIo): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      tag: { type: 'string' },
      asset: { type: 'string' },
      file: { type: 'string' },
      list: { type: 'boolean' },
      token: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
    },
    allowPositionals: false,
  })

  const { appVersion } = await import('#src/helpers/version')
  const context: SwitchContext = {
    io,
    version: appVersion(),
    token: values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
  }

  if (values.file !== undefined) {
    if (values.repo !== undefined || values.tag !== undefined || values.asset !== undefined || values.list === true)
      throw new Error('--file installs a zip directly; it cannot be combined with --repo, --tag, --asset or --list')
    await installFromFile(values.file, context)
    return
  }

  const repo = parseRepoSlug(values.repo ?? DEFAULT_REPO)
  if (repo === null)
    throw new Error(`invalid --repo "${values.repo}" — expected an "owner/name" slug, e.g. ${DEFAULT_REPO}`)

  const requestedTag = values.tag ?? defaultReleaseTag(repo, context.version)
  const release = await fetchRelease(repo, requestedTag, context)
  const skipped = release.assets.filter(asset => !isUiAsset(asset.name ?? '')).map(asset => asset.name ?? '?')
  const usable = release.assets.filter(asset => isUiAsset(asset.name ?? ''))
  const where = `${repo.owner}/${repo.name}@${release.tag}`

  if (values.list === true) {
    if (usable.length === 0)
      throw new Error(noAssetsMessage(where, skipped, requestedTag))
    // One write, so `ui-switch --list | head` does not die on a broken pipe.
    const lines = [`${io.style.bold(where)} — ${usable.length} usable UI asset(s)`]
    for (const asset of usable)
      lines.push(`  ${asset.name}`)
    if (skipped.length > 0)
      lines.push(io.style.dim(`  skipped (not a .zip): ${skipped.join(', ')}`))
    io.write(`${lines.join('\n')}\n`)
    return
  }

  if (usable.length === 0)
    throw new Error(noAssetsMessage(where, skipped, requestedTag))

  const chosen = await chooseAsset(usable, values, context)
  if (chosen === null) {
    io.write('cancelled — nothing was installed\n')
    return
  }

  await installFromUrl(assetDownloadUrl(chosen), fallbackUiName(chosen.name ?? ''), context)
}

async function fetchRelease(repo: RepoSlug, tag: string | null, context: SwitchContext): Promise<{ tag: string, assets: GithubAsset[] }> {
  const url = releaseApiUrl(repo, tag)
  let response: Response
  try {
    response = await fetch(url, { headers: apiHeaders(context) })
  }
  catch (error) {
    throw new Error(`could not reach GitHub: ${describeError(error)}`)
  }

  if (!response.ok)
    throw new Error(describeReleaseFailure(response.status, repo, tag))

  const body = await response.json() as GithubRelease
  return { tag: body.tag_name ?? tag ?? 'latest', assets: Array.isArray(body.assets) ? body.assets : [] }
}

async function chooseAsset(assets: GithubAsset[], values: { asset?: string, yes?: boolean }, context: SwitchContext): Promise<GithubAsset | null> {
  const { io } = context

  if (values.asset !== undefined) {
    const matched = matchAsset(assets.map(asset => asset.name ?? ''), values.asset)
    if (!matched.ok)
      throw new Error(matched.error)
    return assets.find(asset => asset.name === matched.name)!
  }

  const interactive = process.stdin.isTTY === true && values.yes !== true
  if (!interactive) {
    if (assets.length === 1)
      return assets[0]!
    throw new Error([
      `${assets.length} UI assets are available and this session cannot ask which one:`,
      ...assets.map(asset => `  ${asset.name}`),
      '  pick one with --asset <name>, or list them with --list',
    ].join('\n'))
  }

  // One write, so the listing is complete before the prompt (and a piped stdout
  // cannot interleave with it).
  io.write(`${[io.style.bold('Available UI assets'), ...assets.map((asset, index) => `  ${index + 1}) ${asset.name}`)].join('\n')}\n`)

  for (;;) {
    const answer = (await io.prompt(`Select an asset [1-${assets.length}] (empty to cancel) `)).trim()
    if (answer.length === 0)
      return null

    if (/^\d+$/.test(answer)) {
      const index = Number.parseInt(answer, 10)
      if (index >= 1 && index <= assets.length)
        return assets[index - 1]!
    }

    const matched = matchAsset(assets.map(asset => asset.name ?? ''), answer)
    if (matched.ok)
      return assets.find(asset => asset.name === matched.name)!
    io.write(`  ${io.style.dim(matched.error)}\n`)
  }
}

async function installFromFile(value: string, context: SwitchContext): Promise<void> {
  const source = parseFileSource(value)
  if (source.kind === 'path') {
    if (!fs.existsSync(source.path))
      throw new Error(`no file at ${source.path}`)
    if (!fs.statSync(source.path).isFile())
      throw new Error(`${source.path} is not a file`)
    await installArchive(source.path, fallbackUiName(source.path), context)
    return
  }
  await installFromUrl(source.url, fallbackUiName(new URL(source.url).pathname), context)
}

async function installFromUrl(url: string, fallbackName: string, context: SwitchContext): Promise<void> {
  const headers: Record<string, string> = {
    'accept': 'application/octet-stream',
    'user-agent': `home-hosted/${context.version}`,
  }
  if (context.token !== null && context.token.length > 0 && isGithubHost(url))
    headers.authorization = `Bearer ${context.token}`

  const download = await downloadToTemp(url, headers, context)
  try {
    await installArchive(download.file, fallbackName, context)
  }
  finally {
    fs.rmSync(download.dir, { recursive: true, force: true })
  }
}

/** Streams to `os.tmpdir()` so a large body is never buffered in memory. */
async function downloadToTemp(url: string, headers: Record<string, string>, context: SwitchContext): Promise<{ dir: string, file: string }> {
  let response: Response
  try {
    response = await fetch(url, { headers, redirect: 'follow' })
  }
  catch (error) {
    throw new Error(`could not reach ${url}: ${describeError(error)}`)
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

  context.io.write(`${context.io.style.dim(`downloaded ${formatBytes(received)}`)}\n`)
  return { dir, file }
}

async function installArchive(archivePath: string, fallbackName: string, context: SwitchContext): Promise<void> {
  const { UiService } = await import('#src/services/ui')
  const { dataRoot } = await import('#src/helpers/paths')
  const ui = new UiService({ dataRoot })
  const result = await ui.install(archivePath, fallbackName)

  if (!result.ok)
    throw new Error(`nothing was installed: ${result.error}`)

  const { meta } = result
  const label = meta.version === null ? meta.name : `${meta.name} ${meta.version}`
  context.io.write(`${context.io.style.green('UI installed')} — ${label}\n`)
  context.io.write(`  ${context.io.style.dim('state')}  ${ui.directory}\n`)
  context.io.write(`  ${context.io.style.dim('files')}  ${meta.files}\n`)
  context.io.write(`refresh the browser to see it\n`)
}

function apiHeaders(context: SwitchContext): Record<string, string> {
  const headers: Record<string, string> = {
    'accept': 'application/vnd.github+json',
    'user-agent': `home-hosted/${context.version}`,
    'x-github-api-version': '2022-11-28',
  }
  if (context.token !== null && context.token.length > 0)
    headers.authorization = `Bearer ${context.token}`
  return headers
}

function assetDownloadUrl(asset: GithubAsset): string {
  const url = asset.url ?? asset.browser_download_url
  if (url === undefined || url.length === 0)
    throw new Error(`the release metadata for "${asset.name ?? 'an asset'}" carries no download URL`)
  return url
}

function noAssetsMessage(where: string, skipped: string[], tag: string | null): string {
  const lines = [`no usable UI assets in ${where} (expected a .zip)`]
  lines.push(skipped.length > 0 ? `  skipped: ${skipped.join(', ')}` : '  the release has no assets at all')
  if (tag !== null && tag !== 'latest')
    lines.push('  installing a different version silently is worse than failing: try the newest release with --tag latest')
  return lines.join('\n')
}

function describeReleaseFailure(status: number, repo: RepoSlug, tag: string | null): string {
  const slug = `${repo.owner}/${repo.name}`
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

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The citty entry. `ui-switch` keeps parsing its own flags (and its own error
 * messages) inside `uiSwitch`; citty dispatches with the argv it was handed, so
 * the invocation changes and the helpers do not.
 */
export const uiSwitchCommand = defineCommand({
  meta: { name: 'ui-switch', description: 'install a UI from a release asset, a zip file or a URL' },
  run: async ({ rawArgs }) => {
    await uiSwitch(rawArgs, {
      write: text => process.stdout.write(text),
      prompt,
      style,
    })
  },
})
