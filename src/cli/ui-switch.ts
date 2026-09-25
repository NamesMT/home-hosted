import type { GithubAsset } from '#src/providers/ui-release'
import fs from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { defineCommand } from 'citty'
import { prompt, style } from '#src/cli/io'
import {
  assetDownloadUrl,
  DEFAULT_REPO,
  defaultReleaseTag,
  downloadToTemp,
  fallbackUiName,
  fetchRelease,
  isGithubHost,
  isUiAsset,
  matchAsset,
  noAssetsMessage,
  parseFileSource,
  parseRepoSlug,
} from '#src/providers/ui-release'

/**
 * `home-hosted ui-switch` installs the panel's frontend UI without the settings
 * page: a GitHub release asset (the default), a local zip, or an http(s) URL.
 *
 * This module is only ever imported dynamically, after `--home` has been applied,
 * so the modules that read the state directories are imported inside the command
 * rather than at the top. The release-side helpers it shares with `ui-update` are
 * in `#src/providers/ui-release`, and re-exported here so existing importers keep working.
 */

export * from '#src/providers/ui-release'

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

interface SwitchContext {
  io: UiSwitchIo
  version: string
  token: string | null
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
